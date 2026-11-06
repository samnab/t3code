import { describe, expect, it } from "vite-plus/test";
import { METER_STEPS, meterStep, speakingPhrase } from "./voiceLevels";

describe("voice meter levels", () => {
  it("rests at the baseline for silence and a shut gate, and rises with real audio", () => {
    expect(meterStep(0)).toBe(0);
    expect(meterStep(0.004)).toBe(0);
    expect(meterStep(Number.NaN)).toBe(0);
    expect(meterStep(0.02)).toBe(1);
    expect(meterStep(0.15)).toBe(METER_STEPS);
    expect(meterStep(1)).toBe(METER_STEPS);
  });

  it("names who is speaking", () => {
    expect(speakingPhrase(0, 0)).toBe("");
    expect(speakingPhrase(2, 0)).toBe("You're speaking");
    expect(speakingPhrase(0, 3)).toBe("Codex is speaking");
    expect(speakingPhrase(1, 1)).toBe("You and Codex are speaking");
  });
});
