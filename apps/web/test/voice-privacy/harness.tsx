/**
 * A/B/C marker harness for the manual voice privacy boundary, driving the shipped controller,
 * transport and provider. See README.md for the markers and cases; run.ts drives it.
 */ import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  createRealtimeVoiceController,
  type RealtimeVoiceController,
  type VoiceOperationOwner,
  type VoiceTransport,
} from "@t3tools/client-runtime/realtime-voice";
import type { ProviderRealtimeVoiceStartResult } from "@t3tools/contracts";
import { createBrowserVoiceTransport } from "../../src/voice/browserVoiceTransport";
import {
  RealtimeVoiceProvider,
  useRealtimeVoice,
} from "../../src/components/voice/RealtimeVoiceProvider";
import { harnessOwner } from "./owner";
import { providerHooks, randomUUID } from "./stubs";

declare global {
  interface Window {
    voicePrivacy?: {
      runAll: () => Promise<HarnessReport>;
      timeline: Array<{ at: number; event: string }>;
    };
    /** Supplied by the runner: a trusted mod+alt+M press through CDP or sendInputEvent. */
    voicePrivacyPressTrusted?: () => Promise<void>;
  }
}

const egress: Array<{ kind: string; data: string }> = [];
const text = (value: unknown) => {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
};
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: Array<unknown>) => {
    egress.push({ kind: `console.${level}`, data: args.map(text).join(" ") });
    original(...args);
  };
}
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  egress.push({ kind: "fetch", data: `${text(String(input))} ${text(init?.body ?? "")}` });
  return nativeFetch(input, init);
};
const nativeXhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (body) {
  egress.push({ kind: "xhr", data: text(body ?? "") });
  nativeXhrSend.call(this, body);
};
const NativeWebSocket = window.WebSocket;
window.WebSocket = class extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | Array<string>) {
    super((egress.push({ kind: "websocket.open", data: String(url) }), url), protocols);
  }
  override send(data: string | ArrayBuffer | Blob | ArrayBufferView<ArrayBuffer>) {
    egress.push({ kind: "websocket.send", data: text(data) });
    super.send(data);
  }
};
const nativeBeacon = navigator.sendBeacon.bind(navigator);
navigator.sendBeacon = (url, data) => {
  egress.push({ kind: "beacon", data: `${String(url)} ${text(data ?? "")}` });
  return nativeBeacon(url, data);
};
const nativeChannelSend = RTCDataChannel.prototype.send;
RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: never) {
  egress.push({ kind: "datachannel.send", data: text(data) });
  nativeChannelSend.call(this, data);
};

const NativeAudioContext = window.AudioContext;
const NativePeer = window.RTCPeerConnection;
const generator = new NativeAudioContext({ sampleRate: 48_000 });
const oscillator = generator.createOscillator();
const amplitude = generator.createGain();
amplitude.gain.value = 0;
const microphoneOut = generator.createMediaStreamDestination();
oscillator.connect(amplitude).connect(microphoneOut);
oscillator.start();

const FREQUENCY = { A: 700, C: 3300, B0: 1900, B1: 2300 } as const;
const NONCE = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");
const NONCE_BITS = [
  1,
  0,
  ...[...NONCE].flatMap((digit) => {
    const value = Number.parseInt(digit, 16);
    return [3, 2, 1, 0].map((bit) => (value >> bit) & 1);
  }),
];
type Marker = "A" | "B" | "C" | null;
let marker: Marker = null;
const timeline: Array<{ at: number; event: string }> = [];
const t0 = performance.now();
const note = (event: string) => timeline.push({ at: Math.round(performance.now() - t0), event });

function setMarker(next: Marker) {
  marker = next;
  note(`marker ${next ?? "silence"}`);
  const at = generator.currentTime;
  oscillator.frequency.cancelScheduledValues(at);
  amplitude.gain.cancelScheduledValues(at);
  amplitude.gain.setValueAtTime(next === null ? 0 : 0.5, at);
  if (next === "A" || next === "C") oscillator.frequency.setValueAtTime(FREQUENCY[next], at);
  if (next === "B") {
    // 40 ms chirps for two minutes, keyed by the nonce bits.
    for (let index = 0; index < 3_000; index += 1) {
      const bit = NONCE_BITS[index % NONCE_BITS.length];
      oscillator.frequency.setValueAtTime(bit ? FREQUENCY.B1 : FREQUENCY.B0, at + index * 0.04);
    }
  }
}

const realGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
let microphoneGate: Promise<void> | null = null;
let getUserMediaCalls = 0;
const issuedTracks: Array<MediaStreamTrack> = [];
navigator.mediaDevices.getUserMedia = async () => {
  getUserMediaCalls += 1;
  note("getUserMedia called");
  if (microphoneGate) await microphoneGate;
  const source = microphoneOut.stream.getAudioTracks()[0];
  if (source === undefined) throw new Error("synthetic microphone has no track");
  const track = source.clone();
  issuedTracks.push(track);
  return new MediaStream([track]);
};

const analysisContext = new NativeAudioContext({ sampleRate: 48_000 });
interface Recording {
  readonly label: string;
  readonly chunks: Array<Float32Array>;
  stop(): void;
}
const recordings: Array<Recording> = [];
function record(track: MediaStreamTrack, label: string, remote: boolean): Recording {
  const stream = new MediaStream([track]);
  // Chromium only pulls remote WebRTC audio into Web Audio while a media element plays it.
  const element = remote ? new Audio() : null;
  if (element) {
    element.muted = true;
    element.srcObject = stream;
    void element.play().catch(() => {});
  }
  const source = analysisContext.createMediaStreamSource(stream);
  const processor = analysisContext.createScriptProcessor(4096, 1, 1);
  const chunks: Array<Float32Array> = [];
  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor).connect(analysisContext.destination);
  const recording = {
    label,
    chunks,
    stop() {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      element?.pause();
    },
  };
  recordings.push(recording);
  return recording;
}

const WINDOW = 1024;
const DETECT_RMS = 1e-3; // -60 dBFS
const TRACE_RMS = 1e-5; // -100 dBFS
const DETECT_RATIO = 0.2; // share of window energy in the marker bin; white noise is ~2/WINDOW
const ratioToDb = (ratio: number) => 10 * Math.log10((ratio * WINDOW) / 2);

function binRatio(samples: Float32Array, start: number, energy: number, frequency: number) {
  const k = 2 * Math.cos((2 * Math.PI * frequency) / analysisContext.sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let index = 0; index < WINDOW; index += 1) {
    const s0 = (samples[start + index] ?? 0) + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * (s1 * s1 + s2 * s2 - k * s1 * s2)) / (WINDOW * energy);
}

interface Analysis {
  readonly label: string;
  readonly seconds: number;
  readonly windows: number;
  readonly audibleWindows: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly bTrace: number;
  readonly maxBRatio: number;
  readonly medianADb: number | null;
  readonly medianCDb: number | null;
}
const median = (values: Array<number>) =>
  values.length === 0
    ? null
    : Math.round(values.toSorted((x, y) => x - y)[values.length >> 1]! * 10) / 10;

function analyze(recording: Recording): Analysis {
  const total = recording.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const chunk of recording.chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  let windows = 0;
  let audibleWindows = 0;
  let a = 0;
  let b = 0;
  let c = 0;
  let bTrace = 0;
  let maxBRatio = 0;
  const aDb: Array<number> = [];
  const cDb: Array<number> = [];
  for (let start = 0; start + WINDOW <= samples.length; start += WINDOW) {
    windows += 1;
    let energy = 0;
    for (let index = start; index < start + WINDOW; index += 1) energy += samples[index]! ** 2;
    const rms = Math.sqrt(energy / WINDOW);
    if (rms < TRACE_RMS) continue;
    const bRatio =
      binRatio(samples, start, energy, FREQUENCY.B0) +
      binRatio(samples, start, energy, FREQUENCY.B1);
    maxBRatio = Math.max(maxBRatio, bRatio);
    if (bRatio > DETECT_RATIO) bTrace += 1;
    if (rms < DETECT_RMS) continue;
    audibleWindows += 1;
    const aRatio = binRatio(samples, start, energy, FREQUENCY.A);
    const cRatio = binRatio(samples, start, energy, FREQUENCY.C);
    if (aRatio > DETECT_RATIO) {
      a += 1;
      aDb.push(ratioToDb(aRatio));
    }
    if (cRatio > DETECT_RATIO) {
      c += 1;
      cDb.push(ratioToDb(cRatio));
    }
    if (bRatio > DETECT_RATIO) b += 1;
  }
  return {
    label: recording.label,
    seconds: Math.round((total / analysisContext.sampleRate) * 100) / 100,
    windows,
    audibleWindows,
    a,
    b,
    c,
    bTrace,
    maxBRatio: Math.round(maxBRatio * 1e4) / 1e4,
    medianADb: median(aDb),
    medianCDb: median(cDb),
  };
}

let throwNextPeer = false;
const transportContexts: Array<AudioContext> = [];
window.AudioContext = class extends NativeAudioContext {
  constructor(options?: AudioContextOptions) {
    super(options);
    transportContexts.push(this);
  }
};
let tapCount = 0;
window.RTCPeerConnection = class extends NativePeer {
  constructor(configuration?: RTCConfiguration) {
    if (throwNextPeer) {
      throwNextPeer = false;
      throw new Error("injected RTCPeerConnection failure");
    }
    super(configuration);
  }
  override addTrack(track: MediaStreamTrack, ...streams: Array<MediaStream>) {
    // The sender's only audio is this track; recording it captures post-gate PCM.
    record(track, `tap${tapCount++}`, false);
    return super.addTrack(track, ...streams);
  }
};

interface Receiver {
  readonly label: string;
  readonly peer: RTCPeerConnection;
  readonly messages: Array<string>;
}
const receivers: Array<Receiver> = [];
let failNextStart = false;
let failStops = false;
let duringStart: (() => void) | null = null;
let startCalls = 0;
let stopCalls = 0;

async function iceComplete(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const done = () => {
      if (peer.iceGatheringState === "complete") resolve();
    };
    peer.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, 2_000);
  });
}

async function receiverStart(
  owner: VoiceOperationOwner,
  sdp: string,
): Promise<ProviderRealtimeVoiceStartResult> {
  startCalls += 1;
  egress.push({ kind: "startProvider", data: text({ owner, sdp }) });
  if (failNextStart) {
    failNextStart = false;
    throw new Error("injected provider start rejection");
  }
  const peer = new NativePeer();
  const receiver: Receiver = { label: `rx${receivers.length}`, peer, messages: [] };
  receivers.push(receiver);
  peer.addEventListener("track", (event) => {
    record(event.track, receiver.label, true);
  });
  peer.addEventListener("datachannel", (event) => {
    event.channel.addEventListener("message", (message) => {
      receiver.messages.push(text(message.data));
    });
  });
  await peer.setRemoteDescription({ type: "offer", sdp });
  await peer.setLocalDescription(await peer.createAnswer());
  await iceComplete(peer);
  const answer = peer.localDescription?.sdp;
  if (answer === undefined) throw new Error("receiver produced no answer");
  duringStart?.();
  return {
    operationId: owner.operationId,
    voiceSessionToken: `token-${receivers.length}`,
    providerInstanceId: owner.providerInstanceId,
    providerThreadId: owner.providerThreadId,
    providerSessionId: owner.providerSessionId,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    sdp: answer,
  };
}

async function receiverStop(owner: VoiceOperationOwner) {
  stopCalls += 1;
  egress.push({ kind: "stopProvider", data: text(owner) });
  if (failStops) throw new Error("injected provider stop failure");
}
providerHooks.start = receiverStart;
providerHooks.stop = () => receiverStop({ ...harnessOwner(), operationId: "provider-mounted" });

type Revocation = { readonly method: string; readonly action: "pause" | "end" };
interface Handle {
  readonly controller: RealtimeVoiceController;
  readonly modes: Array<string>;
}

function makeController(revoke?: Revocation): Handle {
  const modes: Array<string> = [];
  const at = (method: string) => {
    if (revoke?.method !== method) return;
    note(`revoke ${revoke.action} during ${method}`);
    if (revoke.action === "pause") controller.pause();
    else controller.end();
  };
  const wrap = (real: VoiceTransport): VoiceTransport => ({
    ...real,
    acquireMicrophone: () => {
      const pending = real.acquireMicrophone();
      at("acquireMicrophone");
      return pending;
    },
    createOffer: () => {
      const pending = real.createOffer();
      at("createOffer");
      return pending;
    },
    setLocalDescription: (sdp) => {
      const pending = real.setLocalDescription(sdp);
      at("setLocalDescription");
      return pending;
    },
    gatherIce: () => {
      const pending = real.gatherIce();
      at("gatherIce");
      return pending;
    },
    setRemoteDescription: (sdp) => {
      const pending = real.setRemoteDescription(sdp);
      at("setRemoteDescription");
      return pending;
    },
  });
  const controller = createRealtimeVoiceController({
    createTransport: (events) => {
      const real = createBrowserVoiceTransport(events);
      return revoke ? wrap(real) : real;
    },
    createOperationId: randomUUID,
    validateOwner: () => {},
    startProvider: receiverStart,
    stopProvider: receiverStop,
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
    watchOwner: () => () => {},
    now: () => Date.now(),
    scheduleExpiry: (expiresAt, expired) => {
      const timeout = setTimeout(expired, Math.max(0, expiresAt - Date.now()));
      return () => clearTimeout(timeout);
    },
  });
  controller.subscribe(() => {
    const mode = controller.getSnapshot().mode;
    modes.push(mode);
    note(`mode ${mode}`);
    // B plays whenever the controller does not claim to transmit.
    if (mode !== "transmitting" && marker !== null && marker !== "B") setMarker("B");
  });
  return { controller, modes };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, what: string, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const mode = (handle: Handle) => handle.controller.getSnapshot().mode;

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: unknown;
}
interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly checks: Array<Check>;
  readonly analyses: Array<Analysis>;
  readonly modes: Array<string>;
  readonly error?: string;
}
interface HarnessReport {
  readonly userAgent: string;
  readonly nonce: string;
  readonly probe: unknown;
  readonly cases: Array<CaseResult>;
  readonly egress: Array<{ kind: string; data: string }>;
  readonly timeline: Array<{ at: number; event: string }>;
}

async function withCase(
  name: string,
  body: (checks: Array<Check>, modes: Array<string>) => Promise<void>,
): Promise<CaseResult> {
  note(`case ${name}`);
  recordings.length = 0;
  receivers.length = 0;
  issuedTracks.length = 0;
  startCalls = 0;
  stopCalls = 0;
  failNextStart = false;
  failStops = false;
  duringStart = null;
  microphoneGate = null;
  getUserMediaCalls = 0;
  setMarker(null);
  const checks: Array<Check> = [];
  const modes: Array<string> = [];
  let error: string | undefined;
  try {
    await body(checks, modes);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  setMarker(null);
  await sleep(300);
  const analyses = recordings.map(analyze);
  for (const recording of recordings) recording.stop();
  for (const receiver of receivers) receiver.peer.close();
  const leaked = analyses.filter((analysis) => analysis.b > 0 || analysis.bTrace > 0);
  checks.push({
    name: "no B marker in any received stream or post-gate tap",
    ok: leaked.length === 0,
    detail: leaked,
  });
  checks.push({
    name: "receivers got no data-channel payloads",
    ok: receivers.every((receiver) => receiver.messages.length === 0),
  });
  const ok = error === undefined && checks.every((check) => check.ok);
  return { name, ok, checks, analyses, modes, ...(error ? { error } : {}) };
}

const owner = harnessOwner();
const startTransmitting = async (handle: Handle) => {
  void handle.controller.start(owner);
  await until(() => mode(handle) === "transmitting", "transmitting");
};
const pauseAndAck = async (handle: Handle) => {
  handle.controller.pause();
  await until(() => mode(handle) === "paused", "paused");
  setMarker("B");
};
const resumeTransmitting = async (handle: Handle) => {
  // Private interval ends at the local resume action.
  setMarker(null);
  void handle.controller.resume(owner);
  await until(() => mode(handle) === "transmitting", "transmitting after resume");
};
const byLabel = (analyses: Array<Analysis>, label: string) =>
  analyses.find((analysis) => analysis.label === label);

async function caseAbc(): Promise<CaseResult> {
  const result = await withCase(
    "1. A/C received, B never (live, resume, restart, delayed)",
    async (_, modes) => {
      const first = makeController();
      await startTransmitting(first);
      setMarker("A");
      await sleep(1_500);
      await pauseAndAck(first);
      await sleep(2_000);
      await resumeTransmitting(first);
      setMarker("C");
      await sleep(1_500);
      await pauseAndAck(first);
      await sleep(1_000);
      // Restart: Mic off, then a brand-new controller with B still playing while off.
      first.controller.end();
      await until(() => mode(first) === "off", "off");
      setMarker("B");
      await sleep(1_000);
      setMarker(null);
      const second = makeController();
      await startTransmitting(second);
      setMarker("C");
      await sleep(1_000);
      await pauseAndAck(second);
      // Delayed-work window: keep every receiver recording while B plays.
      await sleep(4_000);
      second.controller.end();
      await until(() => mode(second) === "off", "off");
      await sleep(1_000);
      modes.push(...first.modes, "| restart |", ...second.modes);
    },
  );
  const receiverAnalyses = result.analyses.filter((analysis) => analysis.label.startsWith("rx"));
  const extra: Array<Check> = [
    {
      name: "three provider calls (initial, resume, restart)",
      ok: receiverAnalyses.length === 3,
      detail: receiverAnalyses.length,
    },
    {
      name: "A detected at rx0",
      ok: (byLabel(result.analyses, "rx0")?.a ?? 0) >= 20,
      detail: byLabel(result.analyses, "rx0"),
    },
    {
      name: "C detected at rx1 (after resume)",
      ok: (byLabel(result.analyses, "rx1")?.c ?? 0) >= 20,
      detail: byLabel(result.analyses, "rx1"),
    },
    {
      name: "C detected at rx2 (after restart)",
      ok: (byLabel(result.analyses, "rx2")?.c ?? 0) >= 15,
      detail: byLabel(result.analyses, "rx2"),
    },
    {
      name: "A never reaches the resumed or restarted call",
      ok: receiverAnalyses.slice(1).every((analysis) => analysis.a === 0),
    },
  ];
  return {
    ...result,
    checks: [...result.checks, ...extra],
    ok: result.ok && extra.every((check) => check.ok),
  };
}

/** Detector positive control: B played while transmitting must be detected at the receiver. */
async function caseBDetectable(): Promise<CaseResult> {
  const result = await withCase(
    "0. detector control: B sent while transmitting is detected",
    async (_, modes) => {
      const handle = makeController();
      await startTransmitting(handle);
      setMarker("B");
      await sleep(1_000);
      setMarker(null);
      handle.controller.end();
      await until(() => mode(handle) === "off", "off");
      modes.push(...handle.modes);
    },
  );
  const rx0 = byLabel(result.analyses, "rx0");
  const tap0 = byLabel(result.analyses, "tap0");
  const checks = [
    { name: "B detected at rx0", ok: (rx0?.b ?? 0) >= 20, detail: rx0 },
    { name: "B detected at post-gate tap0", ok: (tap0?.b ?? 0) >= 20, detail: tap0 },
  ];
  return { ...result, checks, ok: result.error === undefined && checks.every((check) => check.ok) };
}

/** Informational: B keeps playing through the resume negotiation, until "transmitting". */
async function caseResumeBleed(): Promise<CaseResult> {
  return withCase(
    "1b. (measurement) B continues during resume negotiation",
    async (checks, modes) => {
      const handle = makeController();
      await startTransmitting(handle);
      setMarker("A");
      await sleep(800);
      await pauseAndAck(handle);
      await sleep(800);
      void handle.controller.resume(owner);
      await until(() => mode(handle) === "transmitting", "transmitting after resume");
      setMarker("C");
      await sleep(1_000);
      handle.controller.end();
      await until(() => mode(handle) === "off", "off");
      modes.push(...handle.modes);
      checks.push({ name: "resumed call connected", ok: receivers.length === 2 });
    },
  );
}

async function caseRaces(): Promise<Array<CaseResult>> {
  const results: Array<CaseResult> = [];
  const methods = [
    "acquireMicrophone",
    "createOffer",
    "setLocalDescription",
    "gatherIce",
    "setRemoteDescription",
  ];
  for (const action of ["pause", "end"] as const) {
    for (const method of methods) {
      results.push(
        await withCase(`2. ${action} while ${method} is pending`, async (checks, modes) => {
          setMarker("B");
          const handle = makeController({ method, action });
          const started = handle.controller.start(owner).then(
            () => "settled",
            () => "rejected",
          );
          const target = action === "pause" ? "paused" : "off";
          await until(() => mode(handle) === target, target);
          await sleep(1_500);
          modes.push(...handle.modes);
          // Informational: WebRTC never settles an operation pending when its peer closes.
          const outcome = await Promise.race([started, sleep(0).then(() => "pending")]);
          checks.push({
            name: "start() promise outcome (informational)",
            ok: true,
            detail: outcome,
          });
          checks.push({ name: "never transmitting", ok: !handle.modes.includes("transmitting") });
          checks.push({
            name: `ends ${target}`,
            ok: mode(handle) === target,
            detail: handle.controller.getSnapshot(),
          });
          checks.push({
            name: "every provider start was stopped",
            ok: stopCalls === startCalls,
            detail: { startCalls, stopCalls },
          });
          checks.push({
            name: "issued microphone tracks stopped",
            ok: issuedTracks.every((track) => track.readyState === "ended"),
          });
          handle.controller.end();
        }),
      );
    }
    results.push(
      await withCase(`2. ${action} while getUserMedia is held pending`, async (checks, modes) => {
        setMarker("B");
        let release = () => {};
        microphoneGate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const handle = makeController();
        const started = handle.controller.start(owner);
        await until(() => getUserMediaCalls === 1, "getUserMedia call");
        if (action === "pause") handle.controller.pause();
        else handle.controller.end();
        await sleep(200);
        release();
        await started;
        const target = action === "pause" ? "paused" : "off";
        await until(() => mode(handle) === target, target);
        await sleep(1_000);
        modes.push(...handle.modes);
        checks.push({ name: "never transmitting", ok: !handle.modes.includes("transmitting") });
        checks.push({ name: "provider never started", ok: startCalls === 0 });
        checks.push({
          name: "late microphone track stopped",
          ok: issuedTracks.length === 1 && issuedTracks[0]!.readyState === "ended",
        });
        handle.controller.end();
      }),
    );
    results.push(
      await withCase(`2. stale provider start resolves after ${action}`, async (checks, modes) => {
        setMarker("B");
        const handle = makeController();
        duringStart = () => {
          duringStart = null;
          if (action === "pause") handle.controller.pause();
          else handle.controller.end();
        };
        await handle.controller.start(owner);
        const target = action === "pause" ? "paused" : "off";
        await until(() => mode(handle) === target, target);
        await sleep(1_500);
        modes.push(...handle.modes);
        checks.push({ name: "never transmitting", ok: !handle.modes.includes("transmitting") });
        checks.push({
          name: "stale start was stopped",
          ok: startCalls === 1 && stopCalls === 1,
          detail: { startCalls, stopCalls },
        });
        checks.push({
          name: "not replacement-blocked",
          ok: !handle.controller.getSnapshot().replacementBlocked,
        });
        handle.controller.end();
      }),
    );
  }
  return results;
}

async function caseErrors(): Promise<Array<CaseResult>> {
  const results: Array<CaseResult> = [];
  results.push(
    await withCase("4. transport constructor throws", async (checks, modes) => {
      setMarker("B");
      throwNextPeer = true;
      const handle = makeController();
      await handle.controller.start(owner).catch(() => {});
      await sleep(1_000);
      modes.push(...handle.modes);
      checks.push({ name: "never transmitting", ok: !handle.modes.includes("transmitting") });
      checks.push({
        name: "ends off with a reason",
        ok: mode(handle) === "off" && handle.controller.getSnapshot().reason !== null,
        detail: handle.controller.getSnapshot(),
      });
      checks.push({ name: "provider never started", ok: startCalls === 0 });
    }),
  );
  results.push(
    await withCase("4. AudioContext suspended while transmitting", async (checks, modes) => {
      const handle = makeController();
      transportContexts.length = 0;
      await startTransmitting(handle);
      setMarker("A");
      await sleep(800);
      await transportContexts.at(-1)?.suspend();
      await until(() => mode(handle) === "off", "off after suspend");
      setMarker("B");
      await transportContexts
        .at(-1)
        ?.resume()
        .catch(() => {});
      await sleep(1_500);
      modes.push(...handle.modes);
      checks.push({
        name: "suspend ends voice with an honest reason",
        ok: handle.controller.getSnapshot().reason?.includes("unavailable") === true,
        detail: handle.controller.getSnapshot(),
      });
      checks.push({
        name: "no transmitting after suspend",
        ok: handle.modes.lastIndexOf("transmitting") < handle.modes.indexOf("ending"),
      });
      checks.push({
        name: "A was received before the fault",
        ok: (byLabel(recordings.map(analyze), "rx0")?.a ?? 0) > 10,
      });
    }),
  );
  results.push(
    await withCase("4. AudioContext suspended before connect", async (checks, modes) => {
      setMarker("B");
      const handle = makeController();
      transportContexts.length = 0;
      const originalResume = NativeAudioContext.prototype.resume;
      // The transport resumes its context on creation; keep it suspended instead.
      NativeAudioContext.prototype.resume = () => Promise.resolve();
      void handle.controller.start(owner);
      await until(() => transportContexts.length === 1, "transport context");
      await transportContexts[0]!.suspend();
      await sleep(3_000);
      NativeAudioContext.prototype.resume = originalResume;
      modes.push(...handle.modes);
      checks.push({
        name: "stays connecting, never transmitting",
        ok: mode(handle) === "connecting" && !handle.modes.includes("transmitting"),
        detail: handle.controller.getSnapshot(),
      });
      handle.controller.end();
      await until(() => mode(handle) === "off", "off");
    }),
  );
  results.push(
    await withCase("4. provider start rejects", async (checks, modes) => {
      setMarker("B");
      failNextStart = true;
      const handle = makeController();
      await handle.controller.start(owner);
      await until(() => mode(handle) === "off", "off");
      await handle.controller.start(owner);
      await sleep(1_000);
      modes.push(...handle.modes);
      const snapshot = handle.controller.getSnapshot();
      checks.push({ name: "never transmitting", ok: !handle.modes.includes("transmitting") });
      checks.push({
        name: "off and replacement-blocked with a reason",
        ok: snapshot.mode === "off" && snapshot.replacementBlocked && snapshot.reason !== null,
        detail: snapshot,
      });
      checks.push({
        name: "a second start is refused",
        ok: startCalls === 1,
        detail: { startCalls },
      });
    }),
  );
  results.push(
    await withCase("4. provider stop fails during pause", async (checks, modes) => {
      const handle = makeController();
      await startTransmitting(handle);
      setMarker("A");
      await sleep(800);
      failStops = true;
      handle.controller.pause();
      await until(() => mode(handle) === "paused", "paused");
      setMarker("B");
      await handle.controller.resume(owner);
      await sleep(1_500);
      modes.push(...handle.modes);
      const snapshot = handle.controller.getSnapshot();
      checks.push({
        name: "stays paused and replacement-blocked",
        ok: snapshot.mode === "paused" && snapshot.replacementBlocked,
        detail: snapshot,
      });
      checks.push({
        name: "resume refused (no second provider start)",
        ok: startCalls === 1,
        detail: { startCalls },
      });
      handle.controller.end();
    }),
  );
  return results;
}

async function caseCycles(): Promise<CaseResult> {
  const cycles = 10;
  const result = await withCase(`5. ${cycles} rapid pause/resume cycles`, async (checks, modes) => {
    const handle = makeController();
    await startTransmitting(handle);
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      setMarker("C");
      await sleep(300);
      await pauseAndAck(handle);
      await sleep(300);
      await resumeTransmitting(handle);
    }
    setMarker("C");
    await sleep(300);
    handle.controller.end();
    await until(() => mode(handle) === "off", "off");
    modes.push(...handle.modes);
    checks.push({
      name: `${cycles + 1} provider calls`,
      ok: startCalls === cycles + 1 && stopCalls === cycles + 1,
      detail: { startCalls, stopCalls },
    });
  });
  const epochs = result.analyses.filter((analysis) => analysis.label.startsWith("rx"));
  const check = {
    name: "C detected in every epoch",
    ok: epochs.length === cycles + 1 && epochs.every((analysis) => analysis.c >= 5),
    detail: epochs.map((analysis) => analysis.c),
  };
  return { ...result, checks: [...result.checks, check], ok: result.ok && check.ok };
}

let exposed: ReturnType<typeof useRealtimeVoice> | null = null;
function Expose() {
  const voice = useRealtimeVoice();
  useEffect(() => {
    exposed = voice;
    note(`provider mode ${voice.snapshot.mode}`);
    if (voice.snapshot.mode !== "transmitting" && marker !== null && marker !== "B") setMarker("B");
  });
  return null;
}
function mountProvider() {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  root.render(
    <RealtimeVoiceProvider returnToOwner={() => {}}>
      <Expose />
    </RealtimeVoiceProvider>,
  );
  return () => {
    root.unmount();
    element.remove();
    exposed = null;
  };
}
const providerMode = () => exposed?.snapshot.mode ?? "unmounted";
const syntheticChord = () =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "m",
      code: "KeyM",
      metaKey: navigator.platform.startsWith("Mac"),
      ctrlKey: !navigator.platform.startsWith("Mac"),
      altKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
const setHidden = (hidden: boolean) => {
  if (hidden)
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  else Reflect.deleteProperty(document, "visibilityState");
  document.dispatchEvent(new Event("visibilitychange"));
};

async function caseShortcutTrustWeb(): Promise<CaseResult> {
  return withCase(
    "3. web: untrusted chord pauses but cannot resume; trusted chord resumes; hidden tab pauses",
    async (checks, modes) => {
      Reflect.deleteProperty(window, "desktopBridge");
      const unmount = mountProvider();
      try {
        await until(() => exposed !== null, "provider");
        exposed!.start(owner.environmentId, owner.threadId);
        await until(() => providerMode() === "transmitting", "transmitting");
        setMarker("A");
        await sleep(800);
        syntheticChord();
        await until(() => providerMode() === "paused", "paused by untrusted chord");
        setMarker("B");
        syntheticChord();
        syntheticChord();
        await sleep(1_500);
        checks.push({
          name: "untrusted chord leaves voice paused",
          ok: providerMode() === "paused" && startCalls === 1,
          detail: { mode: providerMode(), startCalls },
        });
        setMarker(null);
        if (!window.voicePrivacyPressTrusted)
          throw new Error("runner did not supply a trusted key press");
        await window.voicePrivacyPressTrusted();
        await until(() => providerMode() === "transmitting", "transmitting after trusted chord");
        checks.push({ name: "trusted chord resumes (positive control)", ok: true });
        setMarker("C");
        await sleep(800);
        setHidden(true);
        await until(() => providerMode() === "paused", "paused by hidden document");
        setMarker("B");
        await sleep(800);
        setHidden(false);
        await sleep(500);
        checks.push({ name: "visible again does not resume", ok: providerMode() === "paused" });
        checks.push({
          name: "A at rx0, C at rx1",
          ok:
            (byLabel(recordings.map(analyze), "rx0")?.a ?? 0) > 10 &&
            (byLabel(recordings.map(analyze), "rx1")?.c ?? 0) > 10,
        });
      } finally {
        unmount();
        await sleep(300);
        modes.push(providerMode());
      }
    },
  );
}

async function caseShortcutTrustDesktop(): Promise<CaseResult> {
  return withCase(
    "3. desktop: forwarded menu chord cannot resume; lock/suspend IPC pauses",
    async (checks, modes) => {
      const lock: Array<() => void> = [];
      const menu: Array<(action: string) => void> = [];
      Reflect.set(window, "desktopBridge", {
        onVoicePrivacyPause: (listener: () => void) => {
          lock.push(listener);
          return () => {};
        },
        onMenuAction: (listener: (action: string) => void) => {
          menu.push(listener);
          return () => {};
        },
      });
      const unmount = mountProvider();
      try {
        await until(() => exposed !== null && menu.length > 0, "provider");
        exposed!.start(owner.environmentId, owner.threadId);
        await until(() => providerMode() === "transmitting", "transmitting");
        setMarker("A");
        await sleep(800);
        for (const listener of menu) listener("voice.togglePause");
        await until(() => providerMode() === "paused", "paused by forwarded chord");
        setMarker("B");
        for (const listener of menu) listener("voice.togglePause");
        await sleep(1_500);
        checks.push({
          name: "forwarded chord leaves voice paused",
          ok: providerMode() === "paused" && startCalls === 1,
        });
        setHidden(true);
        await sleep(200);
        setHidden(false);
        setMarker(null);
        exposed!.resume();
        await until(() => providerMode() === "transmitting", "transmitting after local resume");
        setMarker("C");
        await sleep(800);
        for (const listener of lock) listener();
        await until(() => providerMode() === "paused", "paused by lock");
        setMarker("B");
        await sleep(1_000);
        checks.push({ name: "still paused after lock", ok: providerMode() === "paused" });
      } finally {
        unmount();
        Reflect.deleteProperty(window, "desktopBridge");
        await sleep(300);
        modes.push(providerMode());
      }
    },
  );
}

async function probe() {
  const result: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    cspMeta:
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content") ?? null,
    audioWorklet: typeof AudioWorkletNode === "function",
  };
  try {
    const worklet = new NativeAudioContext();
    const url = URL.createObjectURL(
      new Blob(
        [
          "registerProcessor('p', class extends AudioWorkletProcessor { process() { return true; } });",
        ],
        { type: "text/javascript" },
      ),
    );
    await worklet.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(worklet, "p");
    node.disconnect();
    result.audioWorkletBlobModule = "ok";
    await worklet.close();
  } catch (error) {
    result.audioWorkletBlobModule = String(error);
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => device.label);
  result.audioInputLabels = inputs;
  // Only touch the real capture API when every input is Chromium's fake device.
  if (inputs.length > 0 && inputs.every((label) => label.startsWith("Fake"))) {
    const stream = await realGetUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];
    const level = analysisContext.createAnalyser();
    analysisContext.createMediaStreamSource(stream).connect(level);
    await sleep(500);
    const samples = new Float32Array(level.fftSize);
    level.getFloatTimeDomainData(samples);
    result.fakeDevice = {
      label: track?.label,
      rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length),
    };
    for (const each of stream.getTracks()) each.stop();
  } else {
    result.fakeDevice = "skipped: inputs are not all Chromium fake devices";
  }
  return result;
}

async function runAll(): Promise<HarnessReport> {
  await generator.resume();
  await analysisContext.resume();
  const cases: Array<CaseResult> = [];
  const environment = await probe();
  cases.push(await caseBDetectable());
  cases.push(await caseAbc());
  cases.push(await caseResumeBleed());
  cases.push(...(await caseRaces()));
  cases.push(await caseShortcutTrustWeb());
  cases.push(await caseShortcutTrustDesktop());
  cases.push(...(await caseErrors()));
  cases.push(await caseCycles());
  return {
    userAgent: navigator.userAgent,
    nonce: NONCE,
    probe: environment,
    cases,
    egress: [
      ...egress,
      ...providerHooks.toasts.map((toast) => ({ kind: "toast", data: text(toast) })),
    ],
    timeline,
  };
}

window.voicePrivacy = { runAll, timeline };
