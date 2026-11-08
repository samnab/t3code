import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createKeywordDetector } from "./keywordDetector";

afterEach(() => vi.unstubAllGlobals());

// SHA-256 of an empty file: every fake asset below is empty.
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ASSETS = [
  "kws.worker.js",
  "sherpa-onnx-wasm-kws-main.wasm",
  "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
  "tokens.txt",
];

function setup() {
  class Worker extends EventTarget {
    postMessage(message: { readonly type: string }) {
      if (message.type === "init")
        queueMicrotask(() =>
          this.dispatchEvent(new MessageEvent("message", { data: { type: "ready" } })),
        );
    }
    terminate() {}
  }
  class AudioWorkletNode extends EventTarget {
    port = Object.assign(new EventTarget(), { start: () => {}, close: () => {} });
    connect = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("Worker", Worker);
  vi.stubGlobal("AudioWorkletNode", AudioWorkletNode);
  vi.stubGlobal("fetch", async (url: string) =>
    url.endsWith("manifest.json")
      ? { json: async () => ({ files: Object.fromEntries(ASSETS.map((name) => [name, EMPTY])) }) }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(0) },
  );
}

// A paused listener's source whose worklet module loads when the test says so.
function source() {
  let load: () => void = () => {};
  const loaded = new Promise<void>((resolve) => (load = resolve));
  const node = {
    context: { audioWorklet: { addModule: () => loaded }, sampleRate: 48_000, destination: {} },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  return { node, load };
}

describe("keyword detector attach", () => {
  it("never lets an older attach that finishes late detach the newer tap", async () => {
    setup();
    const detector = createKeywordDetector({ command: () => {}, failed: () => {} });
    const a = source();
    const b = source();
    const attachA = detector.attach(a.node as never);
    const attachB = detector.attach(b.node as never);
    b.load();
    await attachB;
    expect(b.node.connect).toHaveBeenCalledOnce();
    a.load();
    await attachA;
    expect(b.node.disconnect).not.toHaveBeenCalled();
    expect(a.node.connect).not.toHaveBeenCalled();
    detector.close();
  });
});
