/** Steps above the silent baseline. Only a step change needs a style write. */
export const METER_STEPS = 4;
// ponytail: fixed RMS thresholds from synthetic tones, not tuned on real voices or Bluetooth mics.
const SILENCE_RMS = 0.01;
const FULL_RMS = 0.15;

/** A level's meter step: 0 is the flat silent baseline, 1..METER_STEPS is activity. */
export function meterStep(rms: number): number {
  if (!(rms > SILENCE_RMS)) return 0;
  return Math.max(1, Math.ceil((Math.min(rms, FULL_RMS) / FULL_RMS) * METER_STEPS));
}

/** Screen-reader text for who is audible; changes only when someone starts or stops. */
export function speakingPhrase(input: number, output: number): string {
  if (input > 0 && output > 0) return "You and Codex are speaking";
  if (input > 0) return "You're speaking";
  return output > 0 ? "Codex is speaking" : "";
}
