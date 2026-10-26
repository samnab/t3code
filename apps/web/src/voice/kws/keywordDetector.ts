import * as Schema from "effect/Schema";

/**
 * On-device "T3 privacy pause" / "T3 resume conversation" detection in public/voice/kws. Assets
 * load lazily and are hash-checked here, so the worker needs no network; it answers only with a
 * command. Worker or worklet errors and a backlog over MAX_IN_FLIGHT report `failed`.
 */
export type KeywordCommand = "pause" | "resume";

export interface KeywordDetector {
  /** Feeds `source` to the detector only. Resolves to a detach function. */
  attach(source: MediaStreamAudioSourceNode): Promise<() => void>;
  close(): void;
}

type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "failed" }
  | { readonly type: "processed"; readonly generation: number }
  | { readonly type: "command"; readonly generation: number; readonly command: KeywordCommand };

const ASSETS = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/voice/kws/`;
const MODEL_FILES = {
  wasm: "sherpa-onnx-wasm-kws-main.wasm",
  encoder: "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  decoder: "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  joiner: "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  tokens: "tokens.txt",
} as const;
// 25 blocks of 20 ms: half a second of audio the detector has not seen yet.
const MAX_IN_FLIGHT = 25;

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({ files: Schema.Record(Schema.String, Schema.String) }),
);

async function loadVerified() {
  const { files } = decodeManifest(await (await fetch(`${ASSETS}manifest.json`)).json());
  const load = async (name: string) => {
    const response = await fetch(`${ASSETS}vendor/${name}`);
    if (!response.ok) throw new Error(`Missing keyword asset ${name}`);
    const bytes = await response.arrayBuffer();
    if (files[name] !== (await sha256(bytes))) throw new Error(`Keyword asset ${name} mismatch`);
    return bytes;
  };
  const [wasm, encoder, decoder, joiner, tokens] = await Promise.all([
    load(MODEL_FILES.wasm),
    load(MODEL_FILES.encoder),
    load(MODEL_FILES.decoder),
    load(MODEL_FILES.joiner),
    load(MODEL_FILES.tokens),
  ]);
  return { wasm, encoder, decoder, joiner, tokens };
}

export function createKeywordDetector(events: {
  command(command: KeywordCommand): void;
  failed(): void;
}): KeywordDetector {
  let worker: Worker | null = null;
  let ready: Promise<void> | null = null;
  let generation = 0;
  let inFlight = 0;
  let detachCurrent: (() => void) | null = null;

  const fail = () => {
    if (worker === null) return;
    worker.terminate();
    worker = null;
    ready = null;
    detachCurrent?.();
    events.failed();
  };
  const start = () => {
    const next = new Worker(`${ASSETS}kws.worker.js`);
    worker = next;
    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    next.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      if (worker !== next) return;
      const message = event.data;
      if (message.type === "ready") resolveReady();
      else if (message.type === "failed") {
        rejectReady(new Error("Local listening unavailable"));
        fail();
      } else if (message.generation !== generation) return;
      else if (message.type === "processed") inFlight -= 1;
      else if (message.type === "command") events.command(message.command);
    });
    const onError = () => {
      rejectReady(new Error("Local listening unavailable"));
      if (worker === next) fail();
    };
    next.addEventListener("error", onError);
    next.addEventListener("messageerror", onError);
    void loadVerified().then((files) => {
      if (worker !== next) return;
      next.postMessage({ type: "init", ...files }, Object.values(files));
    }, onError);
    return readyPromise;
  };

  return {
    async attach(source) {
      detachCurrent?.();
      ready ??= start();
      await ready;
      const context = source.context;
      await context.audioWorklet.addModule(`${ASSETS}capture.worklet.js`);
      const target = worker;
      if (target === null) throw new Error("Local listening unavailable");
      const node = new AudioWorkletNode(context, "kws-capture", { outputChannelCount: [1] });
      const mine = ++generation;
      inFlight = 0;
      target.postMessage({ type: "reset", generation: mine, sampleRate: context.sampleRate });
      detachCurrent?.();
      const onBlock = (event: MessageEvent<Float32Array>) => {
        if (generation !== mine || worker !== target) return;
        if (++inFlight > MAX_IN_FLIGHT) {
          fail();
          return;
        }
        target.postMessage({ type: "audio", generation: mine, samples: event.data }, [
          event.data.buffer,
        ]);
      };
      const onProcessorError = () => {
        if (generation === mine) fail();
      };
      node.port.addEventListener("message", onBlock);
      node.port.start();
      node.addEventListener("processorerror", onProcessorError);
      source.connect(node);
      node.connect(context.destination);
      let detached = false;
      const detach = () => {
        if (detached) return;
        detached = true;
        if (detachCurrent === detach) detachCurrent = null;
        // A new generation makes the worker drop any block of this capture still queued.
        if (generation === mine) generation += 1;
        node.port.removeEventListener("message", onBlock);
        node.port.close();
        node.removeEventListener("processorerror", onProcessorError);
        node.disconnect();
        // Closing the call may already have disconnected every output of its source.
        try {
          source.disconnect(node);
        } catch {}
      };
      detachCurrent = detach;
      return detach;
    },
    close() {
      detachCurrent?.();
      worker?.terminate();
      worker = null;
      ready = null;
    },
  };
}

/**
 * The paused conversation's detector-only capture: its own microphone grant and AudioContext,
 * connected to nothing but the detector. `stop` releases both; a late grant after `stop` is
 * released at once. Any capture failure reports `failed`.
 */
export function createLocalListening(detector: KeywordDetector, failed: () => void) {
  let stopCurrent: (() => void) | null = null;
  return {
    start() {
      stopCurrent?.();
      let stopped = false;
      let release = () => {};
      const stop = () => {
        stopped = true;
        release();
      };
      stopCurrent = stop;
      const fail = () => {
        if (stopped) return;
        stop();
        failed();
      };
      void (async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const context = new AudioContext();
        let detach = () => {};
        release = () => {
          detach();
          for (const track of stream.getTracks()) track.stop();
          void context.close().catch(() => {});
        };
        if (stopped) {
          release();
          return;
        }
        for (const track of stream.getTracks()) {
          track.addEventListener("ended", fail);
          track.addEventListener("mute", fail);
        }
        await context.resume();
        if (context.state !== "running") throw new Error("Local listening unavailable");
        detach = await detector.attach(context.createMediaStreamSource(stream));
        if (stopped) release();
      })().catch(fail);
    },
    stop() {
      stopCurrent?.();
      stopCurrent = null;
    },
  };
}
