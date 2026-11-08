import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  clampVoiceVolume,
  createAudioDeviceChooser,
  readVoiceVolume,
  type AudioDeviceChoices,
} from "./audioDevices";

afterEach(() => vi.unstubAllGlobals());

describe("agent voice volume", () => {
  it("clamps numbers to 0–100 and reads anything else as the default", () => {
    expect([-20, 0, 42.4, 100, 250].map(clampVoiceVolume)).toEqual([0, 0, 42, 100, 100]);
    expect([Number.NaN, Infinity, "70", null, undefined, {}].map(clampVoiceVolume)).toEqual([
      100, 100, 100, 100, 100, 100,
    ]);
  });

  it("reads a stored level, or the default for a missing or corrupt one", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null },
    });
    expect(readVoiceVolume()).toBe(100);
    stored.set("t3code:voice-volume", "35");
    expect(readVoiceVolume()).toBe(35);
    stored.set("t3code:voice-volume", "{not json");
    expect(readVoiceVolume()).toBe(100);
    stored.set("t3code:voice-volume", "-5");
    expect(readVoiceVolume()).toBe(0);
  });
});

function storage(microphone: string) {
  const stored = new Map([["t3code:voice-microphone", microphone]]);
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
  return stored;
}

function pending() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function chooser(apply: (kind: string, deviceId: string) => Promise<void>) {
  const view = {
    state: { microphone: "a", speaker: "", switching: null, failed: null } as AudioDeviceChoices,
  };
  const choose = createAudioDeviceChooser(apply, (change) => {
    view.state = change(view.state);
  });
  return { view, choose };
}

describe("audio device choices", () => {
  it("rolls a failed microphone back to the one in use when a speaker change lands meanwhile", async () => {
    const stored = storage("a");
    const microphone = pending();
    const { view, choose } = chooser((kind) =>
      kind === "microphone" ? microphone.promise : Promise.resolve(),
    );
    const b = choose("microphone", "b");
    await choose("speaker", "headphones");
    microphone.reject(new Error("busy"));
    await b;
    expect(view.state).toEqual({
      microphone: "a",
      speaker: "headphones",
      switching: null,
      failed: { kind: "microphone", deviceId: "b" },
    });
    expect(stored.get("t3code:voice-microphone")).toBe("a");
  });

  it("restores the last applied microphone, not an earlier choice still in flight", async () => {
    const stored = storage("a");
    const calls = { b: pending(), c: pending() };
    const { view, choose } = chooser((_kind, deviceId) =>
      deviceId === "b" ? calls.b.promise : calls.c.promise,
    );
    const b = choose("microphone", "b");
    const c = choose("microphone", "c");
    // The transport drops a superseded capture without adopting it.
    calls.b.resolve();
    calls.c.reject(new Error("busy"));
    await Promise.all([b, c]);
    expect(view.state.microphone).toBe("a");
    expect(stored.get("t3code:voice-microphone")).toBe("a");
  });
});
