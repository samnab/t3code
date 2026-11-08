import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createKeywordDetector, createLocalListening } from "./keywordDetector";

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

describe("paused local listening", () => {
  it("keeps the newer listener's microphone published when a stopped one finishes late", async () => {
    const track = () => Object.assign(new EventTarget(), { stop: vi.fn() });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track()] }) },
    });
    vi.stubGlobal(
      "AudioContext",
      class extends EventTarget {
        state = "running";
        resume = async () => {};
        close = async () => {};
        createMediaStreamSource = () => ({});
      },
    );
    let attachA: (detach: () => void) => void = () => {};
    const attaching = { a: new Promise<() => void>((resolve) => (attachA = resolve)) };
    // Each attach call signals the test, so it waits on events, not time.
    const calls: Array<() => void> = [];
    const called = [0, 1].map(() => new Promise<void>((resolve) => calls.push(resolve)));
    const detector = {
      attach: vi.fn(() => {
        const call = detector.attach.mock.calls.length - 1;
        calls[call]?.();
        return call === 0 ? attaching.a : Promise.resolve(() => {});
      }),
      close: () => {},
    };
    const published: Array<string | null> = [];
    const chosen = { id: "a" };
    const listening = createLocalListening(
      detector,
      () => {},
      () => chosen.id,
      (deviceId) => published.push(deviceId),
    );
    listening.start();
    await called[0];
    chosen.id = "b";
    listening.start();
    await called[1];
    // A's attach lands after B owns the microphone.
    const detachA = vi.fn();
    attachA(detachA);
    await attaching.a;
    expect(detachA).toHaveBeenCalledOnce();
    expect(published).toEqual(["a", null, "b"]);
    listening.stop();
  });
});
