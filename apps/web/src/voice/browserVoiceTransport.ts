import type { VoiceTransport } from "@t3tools/client-runtime/realtime-voice";
import { captureMicrophone, microphoneConstraints } from "./audioDevices";

/**
 * A single peer and sink; closing also releases a microphone granted after cancellation.
 * The peer sends a Web Audio destination track. The microphone reaches it only while the gate
 * (the source → destination connection) is open, so the sender never holds the raw track.
 * `tapKeywords` also feeds the microphone to the keyword detector; `microphoneId` ("" = default).
 */
// Audio already in the track pipeline at gate-open predates it. With synthetic tracks, holding 8
// quanta still leaked a 5 ms block in 8-11 of 50 trials; 12 and 24 leaked none in 50 or 100
// (Chromium, Electron 44). Re-measure on physical and Bluetooth mics with
// apps/web/test/voice-privacy/cutoff-benchmark.html.
const GATE_DISCARD_QUANTA = 24;

// Chromium 110+ and Electron; other engines ignore the unknown member. Missing from lib.dom.
declare global {
  interface AudioContextOptions {
    sinkId?: string | { type: "none" };
  }
}

export interface BrowserVoiceTransport extends VoiceTransport {
  /** Captures `deviceId` and swaps it in behind the gate, which keeps its open, shut or muted
   * state. Rejects, keeping the current microphone, when the device cannot be captured. */
  setMicrophone(deviceId: string): Promise<void>;
  /** Plays the assistant on `deviceId` ("" = system default). False where outputs can't be chosen. */
  setSpeaker(deviceId: string): Promise<boolean>;
}

export function createBrowserVoiceTransport(
  events: {
    connected(): void;
    failed(reason: string): void;
  },
  tapKeywords?: (source: MediaStreamAudioSourceNode) => Promise<() => void>,
  microphoneId: () => string = () => "",
): BrowserVoiceTransport {
  const peer = new RTCPeerConnection();
  const audio = document.createElement("audio");
  audio.autoplay = true;
  const channel = peer.createDataChannel("oai-events");
  let microphone: MediaStream | null = null;
  let graph: {
    readonly context: AudioContext;
    readonly source: MediaStreamAudioSourceNode;
    readonly silence: ConstantSourceNode;
    readonly output: MediaStreamAudioDestinationNode;
    readonly inputMeter: AnalyserNode;
    readonly outputMeter: AnalyserNode;
    readonly meterFrame: Float32Array<ArrayBuffer>;
  } | null = null;
  // The assistant stream can only be metered once the microphone's context exists.
  let remote: MediaStream | null = null;
  let assistant: MediaStreamAudioSourceNode | null = null;
  const meterAssistant = () => {
    if (graph === null || remote === null || assistant !== null) return;
    assistant = graph.context.createMediaStreamSource(remote);
    assistant.connect(graph.outputMeter);
  };
  const rms = (analyser: AnalyserNode, frame: Float32Array<ArrayBuffer>) => {
    analyser.getFloatTimeDomainData(frame);
    let sum = 0;
    for (const sample of frame) sum += sample * sample;
    return Math.sqrt(sum / frame.length);
  };
  let gateOpen = false;
  let micMuted = false;
  let opening: GainNode | null = null;
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
    remote ??= event.streams[0] ?? null;
    meterAssistant();
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
    if (closed || graph === null) return;
    if (graph.context.state === "running") events.connected();
    else if (gateOpen || graph.context.state === "closed") fail();
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
  // Losing the microphone in use ends the call. Other devices coming and going do not.
  let unwatchMicrophone = () => {};
  const adoptMicrophone = (stream: MediaStream) => {
    unwatchMicrophone();
    microphone = stream;
    const tracks = stream.getTracks();
    for (const track of tracks) {
      track.enabled = gateOpen;
      track.addEventListener("ended", fail);
      track.addEventListener("mute", fail);
    }
    unwatchMicrophone = () => {
      for (const track of tracks) {
        track.removeEventListener("ended", fail);
        track.removeEventListener("mute", fail);
      }
    };
  };
  cleanups.push(() => unwatchMicrophone());
  const tap = (source: MediaStreamAudioSourceNode) => {
    if (tapKeywords === undefined) return;
    // The detector reports its own failures; the call does not wait on it.
    void tapKeywords(source).then(
      (detach) => (closed ? detach() : cleanups.push(detach)),
      () => {},
    );
  };
  let switches = 0;
  // A muted gate is still created and connected, without the microphone. The zero source keeps it
  // live: with no active input, Chromium's destination emits no frames and the peer sends no RTP.
  const openGate = (open: NonNullable<typeof graph>) => {
    const { context } = open;
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.gain.setValueAtTime(
      1,
      context.currentTime + (GATE_DISCARD_QUANTA * 128) / context.sampleRate,
    );
    open.silence.connect(gain);
    if (!micMuted) open.source.connect(gain);
    gain.connect(open.output);
    gain.connect(open.inputMeter);
    opening = gain;
  };
  return {
    async acquireMicrophone() {
      const stream = await captureMicrophone(microphoneId());
      if (closed) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      adoptMicrophone(stream);
      // After the grant: the constructor can block the renderer 20 s on a stalled audio service.
      // No output device: the graph only feeds the peer and meters, and reopening a Bluetooth
      // output right after the last call blocked the renderer 10 s. The starting click resumes it.
      const context = new AudioContext({ sinkId: { type: "none" } });
      void context.resume().catch(() => {});
      context.addEventListener("statechange", onContextState);
      cleanups.push(() => context.removeEventListener("statechange", onContextState));
      const inputMeter = context.createAnalyser();
      graph = {
        context,
        source: context.createMediaStreamSource(stream),
        silence: context.createConstantSource(),
        output: context.createMediaStreamDestination(),
        inputMeter,
        outputMeter: context.createAnalyser(),
        meterFrame: new Float32Array(inputMeter.fftSize),
      };
      graph.silence.offset.value = 0;
      graph.silence.start();
      meterAssistant();
      for (const track of graph.output.stream.getAudioTracks()) {
        peer.addTrack(track, graph.output.stream);
      }
      tap(graph.source);
    },
    async setMicrophone(deviceId) {
      if (closed || graph === null) return;
      const mine = ++switches;
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
      if (closed || graph === null || mine !== switches) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const previous = microphone;
      // Off the gate and the keyword tap first, so the old device sends nothing more.
      graph.source.disconnect();
      graph = { ...graph, source: graph.context.createMediaStreamSource(stream) };
      adoptMicrophone(stream);
      for (const track of previous?.getTracks() ?? []) {
        track.enabled = false;
        track.stop();
      }
      // An open, unmuted gate is replaced as on unmute: the new device's first frames are discarded.
      if (opening !== null && !micMuted) {
        graph.silence.disconnect(opening);
        opening.disconnect();
        openGate(graph);
      }
      tap(graph.source);
    },
    async setSpeaker(deviceId) {
      if (!("setSinkId" in audio)) return false;
      if (!closed) await audio.setSinkId(deviceId);
      return true;
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
      graph?.context.state === "running",
    enableMicrophone() {
      if (closed || graph === null || graph.context.state !== "running") return;
      gateOpen = true;
      for (const track of microphone?.getTracks() ?? []) track.enabled = true;
      if (opening === null) openGate(graph);
    },
    // Mute cuts the microphone from the gate while silence and playback continue; unmute opens a
    // fresh gate with the same discard. The track stays enabled: the keyword detector must still
    // hear a spoken pause, and some browsers re-acquire a disabled device, tripping `mute`/`ended`.
    setMicMuted(muted) {
      if (closed || muted === micMuted) return;
      micMuted = muted;
      if (graph === null || opening === null) return;
      if (muted) graph.source.disconnect(opening);
      else {
        graph.silence.disconnect(opening);
        opening.disconnect();
        openGate(graph);
      }
    },
    // Meter-only analysers after the gate and on the remote stream; neither reaches the context
    // destination. A shut gate reads zero outright: a disconnected analyser keeps its last frame.
    levels: () =>
      closed || graph === null
        ? { input: 0, output: 0 }
        : {
            input: opening === null || micMuted ? 0 : rms(graph.inputMeter, graph.meterFrame),
            output: assistant === null ? 0 : rms(graph.outputMeter, graph.meterFrame),
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
