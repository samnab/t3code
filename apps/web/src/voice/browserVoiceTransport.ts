import type { VoiceTransport } from "@t3tools/client-runtime/realtime-voice";

/**
 * A single peer and sink; closing also releases a microphone granted after cancellation.
 * The peer sends a Web Audio destination track. The microphone reaches it only while the gate
 * (the source → destination connection) is open, so the sender never holds the raw track.
 */
export function createBrowserVoiceTransport(events: {
  connected(): void;
  failed(reason: string): void;
}): VoiceTransport {
  const peer = new RTCPeerConnection();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  const channel = peer.createDataChannel("oai-events");
  let microphone: MediaStream | null = null;
  let graph: {
    readonly context: AudioContext;
    readonly source: MediaStreamAudioSourceNode;
    readonly output: MediaStreamAudioDestinationNode;
  } | null = null;
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
  peer.addEventListener("track", onTrack);
  peer.addEventListener("connectionstatechange", onConnectionState);
  channel.addEventListener("close", onChannelClose);
  channel.addEventListener("open", onChannelOpen);
  channel.addEventListener("error", onChannelError);
  audio.addEventListener("error", onAudioError);
  cleanups.push(() => {
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
      const context = new AudioContext();
      graph = {
        context,
        source: context.createMediaStreamSource(stream),
        output: context.createMediaStreamDestination(),
      };
      for (const track of graph.output.stream.getAudioTracks()) {
        peer.addTrack(track, graph.output.stream);
      }
      // A context the platform suspends or closes stops carrying audio; end rather than mislabel.
      const onContextState = () => {
        if (context.state !== "running") fail();
      };
      context.addEventListener("statechange", onContextState);
      cleanups.push(() => context.removeEventListener("statechange", onContextState));
      navigator.mediaDevices.addEventListener("devicechange", fail);
      cleanups.push(() => navigator.mediaDevices.removeEventListener("devicechange", fail));
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
    isConnected: () => peer.connectionState === "connected" && channel.readyState === "open",
    enableMicrophone() {
      if (closed || graph === null) return;
      for (const track of microphone?.getTracks() ?? []) track.enabled = true;
      graph.source.connect(graph.output);
      void graph.context.resume().catch(fail);
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
      void graph?.context.close().catch(() => {});
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
