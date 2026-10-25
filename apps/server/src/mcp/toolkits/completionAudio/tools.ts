import {
  CompletionAudioMetadata,
  CompletionAudioPage,
  CompletionAudioReadInput,
  CompletionAudioSetInput,
  CompletionAudioSetResult,
  CompletionAudioBulkOffInput,
  CompletionAudioBulkOffResult,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as CompletionNotifications from "../../../orchestration-v2/CompletionNotificationService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    CompletionNotifications.CompletionNotificationService,
    ThreadManagement.ThreadManagementService,
    ServerEnvironment.ServerEnvironmentIdentity,
    McpInvocationContext.McpInvocationContext,
  ],
};
const limits =
  "This controls persisted completion audio intent. Voice uses configured native provider hooks, which may retain session-start settings; it does not stop already-playing speech. Sound is web/desktop-only and requires a supporting client. No app speech is generated.";
const read = Tool.make("t3_completion_audio_read", {
  ...shared,
  description:
    "Read only completion audio metadata. Pass threadId for one thread; projectId, cursor or limit selects a live offset page including archived threads and children across providers, excluding deleted threads. With no options, reads the calling thread or lists this environment for an external client. No messages or native session IDs. " +
    limits,
  parameters: CompletionAudioReadInput,
  success: Schema.Union([CompletionAudioMetadata, CompletionAudioPage]),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const set = Tool.make("t3_completion_audio_set", {
  ...shared,
  description:
    "Set Off, Voice or Sound for one thread, then read its actual durable state. Omit threadId for the calling thread. Reuse clientRequestId when retrying; a receipt retry cannot reapply a preference after a newer choice. " +
    limits,
  parameters: Schema.Struct({
    ...CompletionAudioSetInput.fields,
    threadId: Schema.optional(ThreadId),
  }),
  success: CompletionAudioSetResult,
}).annotate(Tool.Destructive, true);
const bulk = Tool.make("t3_completion_audio_bulk_off", {
  ...shared,
  description:
    "Turn completion audio Off for this environment, optionally limited to projectId. Includes children and archived threads across all providers; excludes deleted threads. Each call enumerates current matching threads. Reuse clientRequestId for per-target receipt retries. Returns current-state outcomes, total failures and bounded failure details; complete=false when any target failed or was enabled after the original receipt. Does not change the future default: use t3_environment_preferences_update separately. " +
    limits,
  parameters: CompletionAudioBulkOffInput,
  success: CompletionAudioBulkOffResult,
}).annotate(Tool.Destructive, true);
export const CompletionAudioToolkit = Toolkit.make(read, set, bulk);
