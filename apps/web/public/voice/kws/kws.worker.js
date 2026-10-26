// Classic worker so it can importScripts the pinned sherpa-onnx glue. The parent
// (apps/web/src/voice/kws/keywordDetector.ts) supplies hash-checked WASM and model bytes, so no
// network is needed. It posts only commands and acks, never recognised text or audio.

// In: init {wasm, encoder, decoder, joiner, tokens}; reset {generation, sampleRate}; audio
// {generation, samples}. Out: ready | failed; processed and command {generation, endSample}, one
// processed per audio message. endSample counts capture-rate samples since the reset.
"use strict";

// Belt and braces under the worker CSP (connect-src 'none'): nothing below may reach the network.
for (const name of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport"]) {
  try {
    Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
  } catch {}
}

const MODEL_RATE = 16000;
// Pretokenized with the model's bpe.model. "T3" is spoken "T three".
const KEYWORDS = [
  "▁T ▁THREE ▁P RI V A C Y ▁PA U SE @pause",
  "▁T ▁THREE ▁RE S U ME ▁CON VER S ATION @resume",
].join("\n");

let kws = null;
let stream = null;
let resampler = null;
let generation = -1;
let endSample = 0;
let failed = false;

/**
 * Streaming windowed-sinc resampler from the capture rate to 16 kHz. Output sample n sits at
 * input position n * step, so detections map back to capture sample positions exactly; 16 kHz
 * samples are never reinterpreted at the capture rate.
 */
function createResampler(inputRate) {
  const step = inputRate / MODEL_RATE;
  const cutoff = (0.45 * MODEL_RATE) / inputRate; // cycles per input sample, ~7.2 kHz
  const half = Math.ceil(8 * step);
  let buffer = new Float32Array(0);
  let base = 0; // absolute input index of buffer[0]
  let next = 0; // next output index
  return (input) => {
    const merged = new Float32Array(buffer.length + input.length);
    merged.set(buffer);
    merged.set(input, buffer.length);
    buffer = merged;
    const out = [];
    for (;;) {
      const x = next * step;
      const first = Math.ceil(x - half);
      const last = Math.floor(x + half);
      if (last - base >= buffer.length) break;
      let sum = 0;
      for (let j = first; j <= last; j++) {
        const t = x - j;
        const i = j - base;
        const sample = i >= 0 ? buffer[i] : 0;
        const arg = 2 * cutoff * t;
        const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
        const window = 0.5 + 0.5 * Math.cos((Math.PI * t) / half);
        sum += sample * 2 * cutoff * sinc * window;
      }
      out.push(sum);
      next++;
    }
    const keepFrom = Math.max(0, Math.ceil(next * step - half) - base);
    buffer = buffer.slice(keepFrom);
    base += keepFrom;
    return Float32Array.from(out);
  };
}

function fail() {
  failed = true;
  try {
    stream?.free();
    kws?.free();
  } catch {}
  stream = null;
  kws = null;
  self.postMessage({ type: "failed" });
}

async function init(message) {
  // The pinned build is not modularised: it reads a global Module config when its script runs.
  const Module = await new Promise((resolve, reject) => {
    self.Module = {
      wasmBinary: message.wasm,
      print: () => {},
      printErr: () => {},
      onAbort: reject,
      onRuntimeInitialized: () => resolve(self.Module),
    };
    importScripts("./vendor/sherpa-onnx-wasm-kws-main.js", "./vendor/sherpa-onnx-kws.js");
  });
  const files = {
    "encoder.onnx": message.encoder,
    "decoder.onnx": message.decoder,
    "joiner.onnx": message.joiner,
    "tokens.txt": message.tokens,
  };
  for (const [name, bytes] of Object.entries(files)) {
    Module.FS_createDataFile("/", name, new Uint8Array(bytes), true, false, false);
  }
  kws = self.createKws(Module, {
    featConfig: { samplingRate: MODEL_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: "/encoder.onnx", decoder: "/decoder.onnx", joiner: "/joiner.onnx" },
      tokens: "/tokens.txt",
      provider: "cpu",
      modelType: "",
      numThreads: 1,
      debug: 0,
      modelingUnit: "bpe",
      bpeVocab: "",
    },
    // Tuned on the synthetic TTS set in /tmp/t3-voice-kws (REPORT.md): the default score of 1.0
    // caught half the phrases; 3.0 caught 40/48 with no false resume in 14 minutes of near-misses.
    maxActivePaths: 8,
    numTrailingBlanks: 1,
    keywordsScore: 3.0,
    keywordsThreshold: 0.1,
    keywords: KEYWORDS,
  });
  if (!kws.handle) throw new Error("keyword spotter did not initialise");
}

function onAudio(message) {
  if (message.generation !== generation || stream === null) return;
  endSample += message.samples.length;
  stream.acceptWaveform(MODEL_RATE, resampler(message.samples));
  while (kws.isReady(stream)) {
    kws.decode(stream);
    const keyword = kws.getResult(stream).keyword;
    if (keyword === "pause" || keyword === "resume") {
      kws.reset(stream);
      self.postMessage({ type: "command", command: keyword, generation, endSample });
    }
  }
  self.postMessage({ type: "processed", generation, endSample });
}

let queue = Promise.resolve();
self.addEventListener("message", (event) => {
  const message = event.data;
  queue = queue.then(async () => {
    if (failed) return;
    try {
      if (message.type === "init") {
        await init(message);
        // Same-origin script loads and nested workers are the last ways out once running.
        self.importScripts = undefined;
        self.Worker = undefined;
        self.postMessage({ type: "ready" });
      } else if (kws === null) {
        fail();
      } else if (message.type === "reset") {
        stream?.free();
        stream = kws.createStream();
        resampler = createResampler(message.sampleRate);
        generation = message.generation;
        endSample = 0;
      } else if (message.type === "audio") {
        onAudio(message);
      }
    } catch {
      fail();
    }
  });
});
