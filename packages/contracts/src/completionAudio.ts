import * as Schema from "effect/Schema";
import {
  CommandId,
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const CompletionAudioMode = Schema.Literals(["off", "voice", "sound"]);
export type CompletionAudioMode = typeof CompletionAudioMode.Type;

export const CompletionAudioSettings = Schema.Struct({
  defaultMode: CompletionAudioMode,
  tone: Schema.Literals(["completion", "input"]),
  volume: Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export type CompletionAudioSettings = typeof CompletionAudioSettings.Type;

export const CompletionAudioSettingsPatch = Schema.Struct({
  defaultMode: Schema.optionalKey(CompletionAudioSettings.fields.defaultMode),
  tone: Schema.optionalKey(CompletionAudioSettings.fields.tone),
  volume: Schema.optionalKey(CompletionAudioSettings.fields.volume),
});

const isCompletionAudioMode = Schema.is(CompletionAudioMode);

/** Preserve an explicit stored false as Off; missing fields leave a draft untouched. */
export function readStoredCompletionAudio(stored: {
  readonly completionAudio?: unknown;
  readonly voiceNotifications?: unknown;
}): CompletionAudioMode | null {
  if (isCompletionAudioMode(stored.completionAudio)) return stored.completionAudio;
  return typeof stored.voiceNotifications === "boolean"
    ? stored.voiceNotifications
      ? "voice"
      : "off"
    : null;
}

/** Untouched creation omits both fields so the destination's current default applies. */
export function completionAudioCreationFields(mode: CompletionAudioMode | null | undefined) {
  return mode == null ? {} : { completionAudio: mode, voiceNotifications: mode === "voice" };
}

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

const CompletionAudioRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => {
    try {
      encodeURIComponent(value);
      return true;
    } catch {
      return "clientRequestId must contain paired Unicode surrogates.";
    }
  }),
);

export const CompletionAudioMetadata = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  mode: CompletionAudioMode,
  voiceNotifications: Schema.Boolean,
  archived: Schema.Boolean,
});
export type CompletionAudioMetadata = typeof CompletionAudioMetadata.Type;

export const CompletionAudioGetInput = Schema.Struct({ threadId: ThreadId });
export type CompletionAudioGetInput = typeof CompletionAudioGetInput.Type;
export const CompletionAudioListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CompletionAudioListInput = typeof CompletionAudioListInput.Type;
export const CompletionAudioPage = Schema.Struct({
  items: Schema.Array(CompletionAudioMetadata),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type CompletionAudioPage = typeof CompletionAudioPage.Type;
export const CompletionAudioSetInput = Schema.Struct({
  threadId: ThreadId,
  mode: CompletionAudioMode,
  clientRequestId: CompletionAudioRequestId,
});
export type CompletionAudioSetInput = typeof CompletionAudioSetInput.Type;
export const CompletionAudioSetResult = Schema.Struct({
  commandId: CommandId,
  sequence: NonNegativeInt,
  hadReceipt: Schema.Boolean,
  state: CompletionAudioMetadata,
});
export type CompletionAudioSetResult = typeof CompletionAudioSetResult.Type;
export const CompletionAudioBulkOffInput = Schema.Struct({
  clientRequestId: CompletionAudioRequestId,
  projectId: Schema.optional(ProjectId),
});
export type CompletionAudioBulkOffInput = typeof CompletionAudioBulkOffInput.Type;
export const CompletionAudioFailureReason = Schema.Literals([
  "not_found",
  "permission_denied",
  "superseded",
  "failed",
]);
export const CompletionAudioBulkOffResult = Schema.Struct({
  environmentId: EnvironmentId,
  total: NonNegativeInt,
  turnedOff: NonNegativeInt,
  alreadyOff: NonNegativeInt,
  failedCount: NonNegativeInt,
  failed: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      reason: CompletionAudioFailureReason,
      mode: Schema.optional(CompletionAudioMode),
    }),
  ).check(Schema.isMaxLength(100)),
  failuresTruncated: Schema.Boolean,
  complete: Schema.Boolean,
});
export type CompletionAudioBulkOffResult = typeof CompletionAudioBulkOffResult.Type;

export class CompletionAudioError extends Schema.TaggedError<CompletionAudioError>()(
  "CompletionAudioError",
  {
    reason: CompletionAudioFailureReason,
    threadId: Schema.optional(ThreadId),
  },
) {
  override get message(): string {
    return this.reason === "not_found"
      ? "The thread was not found."
      : this.reason === "permission_denied"
        ? "Completion audio permission was denied."
        : "The completion audio operation could not be completed.";
  }
}

export const CompletionAudioReadInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  projectId: CompletionAudioListInput.fields.projectId,
  cursor: CompletionAudioListInput.fields.cursor,
  limit: CompletionAudioListInput.fields.limit,
}).check(
  Schema.makeFilter((input) =>
    input.threadId === undefined ||
    (input.projectId === undefined && input.cursor === undefined && input.limit === undefined)
      ? true
      : "Choose one thread or a project page.",
  ),
);
export type CompletionAudioReadInput = typeof CompletionAudioReadInput.Type;
