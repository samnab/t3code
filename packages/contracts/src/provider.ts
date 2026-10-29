import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { IsoDateTime, ProviderSessionId, ProviderThreadId, ThreadId } from "./baseSchemas.ts";
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ChatAttachment,
} from "./chatAttachment.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  /** Internal recovery: permits empty turns only for adapters supporting promptless continuation. */
  continuation: Schema.optional(Schema.Boolean),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(
      Schema.makeFilter((attachments) => getProviderAttachmentLimitError(attachments) ?? true),
    ),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderUploadFeedbackInput = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderUploadFeedbackInput = typeof ProviderUploadFeedbackInput.Type;

export const ProviderUploadFeedbackResult = Schema.Struct({
  feedbackId: TrimmedNonEmptyString,
});
export type ProviderUploadFeedbackResult = typeof ProviderUploadFeedbackResult.Type;

export class ProviderUploadFeedbackError extends Schema.TaggedError<ProviderUploadFeedbackError>()(
  "ProviderUploadFeedbackError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to upload feedback for thread ${this.threadId}.`;
  }
}

const RealtimeVoiceOwnerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const ProviderRealtimeVoiceStartInput = Schema.Struct({
  threadId: ThreadId,
  /** Created by the capturing client before microphone/negotiation awaits; absent for legacy callers. */
  operationId: Schema.optional(RealtimeVoiceOwnerId),
  /** The browser's WebRTC SDP offer, verbatim: SDP needs its trailing CRLF, so never trim it. */
  sdp: Schema.String.check(Schema.isMinLength(1)),
});
export type ProviderRealtimeVoiceStartInput = typeof ProviderRealtimeVoiceStartInput.Type;

export const ProviderRealtimeVoiceStartResult = Schema.Struct({
  operationId: Schema.optional(RealtimeVoiceOwnerId),
  /** T3 ownership token, distinct from the provider's native realtime session ID. */
  voiceSessionToken: Schema.optional(RealtimeVoiceOwnerId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  providerSessionId: Schema.optional(ProviderSessionId),
  providerThreadId: Schema.optional(ProviderThreadId),
  expiresAt: Schema.optional(IsoDateTime),
  nativeRealtimeSessionId: Schema.optional(TrimmedNonEmptyString),
  /** The provider's SDP answer to set as the remote description. */
  sdp: Schema.String,
});
export type ProviderRealtimeVoiceStartResult = typeof ProviderRealtimeVoiceStartResult.Type;

export const ProviderRealtimeVoiceStopInput = Schema.Struct({
  threadId: ThreadId,
  operationId: Schema.optional(RealtimeVoiceOwnerId),
  voiceSessionToken: Schema.optional(RealtimeVoiceOwnerId),
  providerSessionId: Schema.optional(ProviderSessionId),
  providerThreadId: Schema.optional(ProviderThreadId),
});
export type ProviderRealtimeVoiceStopInput = typeof ProviderRealtimeVoiceStopInput.Type;

export class ProviderRealtimeVoiceError extends Schema.TaggedError<ProviderRealtimeVoiceError>()(
  "ProviderRealtimeVoiceError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
    /** The host refused before reaching the provider, so no call can be left open. */
    refusedBeforeStart: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return `Realtime voice failed for thread ${this.threadId}.`;
  }
}
