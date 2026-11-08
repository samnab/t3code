import type { VoiceTransport } from "@t3tools/client-runtime/realtime-voice";
import { captureMicrophone, microphoneConstraints, type AudioDeviceKind } from "./audioDevices";

/**
 * One peer and sink. The microphone reaches the sender only through the open gate; `tapKeywords`
 * feeds the source to the on-device detector while keywords are on. `devices.adopted` reports every
 * device the call actually uses (null once closed): the only source for "in use".
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
  /** Moves the call to `deviceId` behind the gate, which keeps its open, shut or muted state.
   * Resolves once adopted, superseded by a later choice, or closed. Rejects when the latest choice
   * cannot be captured; the call then stays on the adopted device. */
  setMicrophone(deviceId: string): Promise<void>;
  /** Plays the assistant on `deviceId` ("" = system default). False where outputs can't be chosen.
   * Rejects when setSinkId fails; the element keeps its last sink. */
  setSpeaker(deviceId: string): Promise<boolean>;
  /** The assistant's playback level, 0–100. Playback only: capture, gate and keywords are untouched. */
  setVolume(volume: number): void;
}

export function createBrowserVoiceTransport(
  events: {
    connected(): void;
    failed(reason: string): void;
  },
  tapKeywords?: (source: MediaStreamAudioSourceNode) => Promise<() => void>,
  keywordsOn = true,
  devices: {
    readonly microphone: () => string;
    readonly adopted: (kind: AudioDeviceKind, deviceId: string | null) => void;
  } = { microphone: () => "", adopted: () => {} },
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
  let detachKeywords: (() => void) | null = null;
  let tapped: MediaStreamAudioSourceNode | null = null;
  let tapping = false;
  // One tap at a time, on the current source; a toggle, switch or close during a pending attach
  // is settled once it resolves.
  const syncKeywords = () => {
    if (tapKeywords === undefined || tapping) return;
    const wanted = closed || !keywordsOn ? null : (graph?.source ?? null);
    if (detachKeywords !== null && tapped !== wanted) {
      detachKeywords();
      detachKeywords = null;
      tapped = null;
    }
    if (wanted === null || detachKeywords !== null) return;
    tapping = true;
    tapped = wanted;
    // The detector reports its own failures; the call does not wait on it.
    void tapKeywords(wanted).then(
      (detach) => {
        tapping = false;
        detachKeywords = detach;
        syncKeywords();
      },
      () => {
        tapping = false;
        tapped = null;
      },
    );
  };
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
  // Every granted stream not yet released: the adopted one and a replacement on its way in. close()
  // stops them all; a grant that lands after close is stopped on arrival.
  const held = new Set<MediaStream>();
  const release = (stream: MediaStream) => {
    held.delete(stream);
    for (const track of stream.getTracks()) {
      track.enabled = false;
      track.stop();
    }
  };
  // `adoptedId` is the microphone the call captures; `wanted` the latest choice; `waiter` settles
  // that choice's setMicrophone.
  let adoptedId: string | null = null;
  let wanted: string | null = null;
  let waiter: { readonly resolve: () => void; readonly reject: (error: unknown) => void } | null =
    null;
  const takeWaiter = () => {
    const current = waiter;
    waiter = null;
    return current;
  };
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
  const swapIn = (stream: MediaStream, deviceId: string) => {
    if (graph === null) return;
    const previous = microphone;
    // Off the gate and the keyword tap first, so the old device sends nothing more.
    graph.source.disconnect();
    graph = { ...graph, source: graph.context.createMediaStreamSource(stream) };
    adoptMicrophone(stream);
    if (previous !== null) release(previous);
    // An open, unmuted gate is replaced as on unmute: the new device's first frames are discarded.
    if (opening !== null && !micMuted) {
      graph.silence.disconnect(opening);
      opening.disconnect();
      openGate(graph);
    }
    syncKeywords();
    adoptedId = deviceId;
    devices.adopted("microphone", deviceId);
  };
  // Moves the call to the latest choice, one capture at a time. A grant that arrives superseded is
  // released; only the latest choice's failure is reported, and the adopted device stays.
  let driving = false;
  const drive = async () => {
    if (driving || graph === null) return;
    driving = true;
    try {
      while (!closed && wanted !== null && wanted !== adoptedId) {
        const target = wanted;
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(target));
        } catch (error) {
          if (target === wanted) {
            wanted = adoptedId;
            takeWaiter()?.reject(error);
          }
          continue;
        }
        if (closed || target !== wanted) {
          release(stream);
          continue;
        }
        held.add(stream);
        swapIn(stream, target);
        takeWaiter()?.resolve();
      }
    } finally {
      driving = false;
    }
  };
  const acquire = async () => {
    const first = wanted ?? devices.microphone();
    const captured = await captureMicrophone(first);
    const stream = captured.stream;
    if (closed) {
      release(stream);
      return;
    }
    held.add(stream);
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
    syncKeywords();
    adoptedId = captured.deviceId;
    devices.adopted("microphone", adoptedId);
    // With no newer choice, a saved device that is gone stays chosen (shown disconnected), not retried.
    if (wanted === null || wanted === first) wanted = adoptedId;
    // A choice made during the grant is captured before this returns, so before the gate can open.
    await drive();
  };
  // The element plays on the system default until a setSinkId succeeds.
  devices.adopted("speaker", "");
  return {
    acquireMicrophone: acquire,
    setMicrophone(deviceId) {
      if (closed) return Promise.resolve();
      takeWaiter()?.resolve();
      wanted = deviceId;
      if (graph !== null && deviceId === adoptedId) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        waiter = { resolve, reject };
        void drive();
      });
    },
    async setSpeaker(deviceId) {
      if (!("setSinkId" in audio)) return false;
      if (closed) return true;
      await audio.setSinkId(deviceId);
      // The last setSinkId to succeed is where the element plays.
      if (!closed) devices.adopted("speaker", deviceId);
      return true;
    },
    // The element outlives each remote track, so a reconnected stream keeps the level.
    setVolume(volume) {
      if (!closed) audio.volume = volume / 100;
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
    setKeywords(on) {
      keywordsOn = on;
      syncKeywords();
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
      syncKeywords();
      for (const cleanup of cleanups) cleanup();
      for (const stream of held) release(stream);
      microphone = null;
      takeWaiter()?.resolve();
      adoptedId = null;
      devices.adopted("microphone", null);
      devices.adopted("speaker", null);
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
