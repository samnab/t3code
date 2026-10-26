import type { VoiceTransport } from "@t3tools/client-runtime/realtime-voice";

/**
 * A single peer and sink; closing also releases a microphone granted after cancellation.
 * The peer sends a Web Audio destination track. The microphone reaches it only while the gate
 * (the source → destination connection) is open, so the sender never holds the raw track.
 * `tapKeywords`, when given, also feeds the microphone to the local keyword detector.
 */
// Audio already in the track pipeline at gate-open predates it. With synthetic tracks, holding 8
// quanta still leaked a 5 ms block in 8-11 of 50 trials; 12 and 24 leaked none in 50 or 100
// (Chromium, Electron 44). Re-measure on physical and Bluetooth mics with
// apps/web/test/voice-privacy/cutoff-benchmark.html.
const GATE_DISCARD_QUANTA = 24;

export function createBrowserVoiceTransport(
  events: {
    connected(): void;
    failed(reason: string): void;
  },
  tapKeywords?: (source: MediaStreamAudioSourceNode) => Promise<() => void>,
): VoiceTransport {
  // Created and resumed inside the user gesture that starts or resumes voice, so autoplay policy
  // lets it run. Until it runs the transport reports not connected and the gate stays shut.
  // Created first: if this constructor throws, no peer exists yet to leak.
  const context = new AudioContext();
  void context.resume().catch(() => {});
  let peer: RTCPeerConnection;
  try {
    peer = new RTCPeerConnection();
  } catch (error) {
    void context.close().catch(() => {});
    throw error;
  }
  const audio = document.createElement("audio");
  audio.autoplay = true;
  const channel = peer.createDataChannel("oai-events");
  let microphone: MediaStream | null = null;
  let graph: {
    readonly source: MediaStreamAudioSourceNode;
    readonly output: MediaStreamAudioDestinationNode;
  } | null = null;
  let gateOpen = false;
  let closed = false;
  let cancelIce: (() => void) | undefined;
  const cleanups: Array<() => void> = [];
  const fail = () => {
    if (!closed)
      events.failed("Voice ended because the microphone or audio device became unavailable.");
  };
  const onTrack = (event: RTCTrackEvent) => {
    if (closed) return;
    audio.srcObject = event.streams[0] ?? null;
    void audio.play().catch(() => {
      if (!closed) events.failed("Voice playback is unavailable. Microphone off.");
    });
  };
  const onConnectionState = () => {
    if (closed) return;
    if (peer.connectionState === "connected") events.connected();
    else if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
      events.failed("Voice connection lost. Microphone off.");
    }
  };
  const onChannelClose = () => {
    if (!closed) events.failed("Voice control channel closed.");
  };
  const onChannelOpen = () => {
    if (!closed) events.connected();
  };
  const onChannelError = () => {
    if (!closed) events.failed("Voice control channel failed.");
  };
  const onAudioError = () => {
    if (!closed) events.failed("Voice playback failed.");
  };
  // A suspended context carries no audio: unready before the gate opens, an ended call after.
  const onContextState = () => {
    if (closed) return;
    if (context.state === "running") events.connected();
    else if (gateOpen || context.state === "closed") fail();
  };
  peer.addEventListener("track", onTrack);
  peer.addEventListener("connectionstatechange", onConnectionState);
  channel.addEventListener("close", onChannelClose);
  channel.addEventListener("open", onChannelOpen);
  channel.addEventListener("error", onChannelError);
  audio.addEventListener("error", onAudioError);
  context.addEventListener("statechange", onContextState);
  cleanups.push(() => {
    context.removeEventListener("statechange", onContextState);
    peer.removeEventListener("track", onTrack);
    peer.removeEventListener("connectionstatechange", onConnectionState);
    channel.removeEventListener("close", onChannelClose);
    channel.removeEventListener("open", onChannelOpen);
    channel.removeEventListener("error", onChannelError);
    audio.removeEventListener("error", onAudioError);
  });
  return {
    async acquireMicrophone() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (closed) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      microphone = stream;
      for (const track of stream.getTracks()) {
        track.enabled = false;
        track.addEventListener("ended", fail);
        track.addEventListener("mute", fail);
        cleanups.push(() => {
          track.removeEventListener("ended", fail);
          track.removeEventListener("mute", fail);
        });
      }
      graph = {
        source: context.createMediaStreamSource(stream),
        output: context.createMediaStreamDestination(),
      };
      for (const track of graph.output.stream.getAudioTracks()) {
        peer.addTrack(track, graph.output.stream);
      }
      navigator.mediaDevices.addEventListener("devicechange", fail);
      cleanups.push(() => navigator.mediaDevices.removeEventListener("devicechange", fail));
      if (tapKeywords !== undefined) {
        const source = graph.source;
        // The detector reports its own failures; the call does not wait on it.
        void tapKeywords(source).then(
          (detach) => (closed ? detach() : cleanups.push(detach)),
          () => {},
        );
      }
    },
    async createOffer() {
      const offer = await peer.createOffer();
      if (offer.sdp === undefined) throw new Error("No SDP offer was generated.");
      return offer.sdp;
    },
    setLocalDescription: (sdp) => peer.setLocalDescription({ type: "offer", sdp }),
    gatherIce() {
      if (closed || peer.iceGatheringState === "complete") return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = () => {
          peer.removeEventListener("icegatheringstatechange", onState);
          peer.removeEventListener("icecandidate", onCandidate);
          clearTimeout(cap);
          cancelIce = undefined;
          resolve();
        };
        const onState = () => {
          if (peer.iceGatheringState === "complete") finish();
        };
        const onCandidate = (event: RTCPeerConnectionIceEvent) => {
          if (event.candidate === null) finish();
        };
        const cap = setTimeout(finish, 2_000);
        cancelIce = finish;
        peer.addEventListener("icegatheringstatechange", onState);
        peer.addEventListener("icecandidate", onCandidate);
      });
    },
    localSdp() {
      const sdp = peer.localDescription?.sdp;
      if (sdp === undefined) throw new Error("No local SDP description was generated.");
      return sdp;
    },
    setRemoteDescription: (sdp) => peer.setRemoteDescription({ type: "answer", sdp }),
    isConnected: () =>
      peer.connectionState === "connected" &&
      channel.readyState === "open" &&
      context.state === "running",
    enableMicrophone() {
      if (closed || graph === null || context.state !== "running") return;
      gateOpen = true;
      for (const track of microphone?.getTracks() ?? []) track.enabled = true;
      const opening = context.createGain();
      opening.gain.value = 0;
      opening.gain.setValueAtTime(
        1,
        context.currentTime + (GATE_DISCARD_QUANTA * 128) / context.sampleRate,
      );
      graph.source.connect(opening);
      opening.connect(graph.output);
    },
    close() {
      if (closed) return;
      closed = true;
      // Shut the gate before anything else so no later microphone frame reaches the sender.
      graph?.source.disconnect();
      for (const cleanup of cleanups) cleanup();
      for (const track of microphone?.getTracks() ?? []) {
        track.enabled = false;
        track.stop();
      }
      microphone = null;
      for (const track of graph?.output.stream.getTracks() ?? []) track.stop();
      void context.close().catch(() => {});
      graph = null;
      cancelIce?.();
      channel.close();
      peer.close();
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    },
  };
}
