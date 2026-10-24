import * as Schema from "effect/Schema";

export const CompletionAudioMode = Schema.Literals(["off", "voice", "sound"]);
export type CompletionAudioMode = typeof CompletionAudioMode.Type;

export const CompletionAudioSettings = Schema.Struct({
  defaultMode: CompletionAudioMode,
  tone: Schema.Literals(["completion", "input"]),
  volume: Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type CompletionAudioSettings = typeof CompletionAudioSettings.Type;

export const DEFAULT_COMPLETION_AUDIO_SETTINGS = {
  defaultMode: "off",
  tone: "completion",
  volume: 1,
} satisfies CompletionAudioSettings;

/** Older thread records and events carry only the provider-hook voice bit. */
export function resolveCompletionAudio(input: {
  readonly completionAudio?: CompletionAudioMode | undefined;
  readonly voiceNotifications?: boolean | undefined;
}): CompletionAudioMode {
  return input.completionAudio ?? (input.voiceNotifications === true ? "voice" : "off");
}
