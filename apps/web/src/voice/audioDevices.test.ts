import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { clampVoiceVolume, readVoiceVolume } from "./audioDevices";

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
