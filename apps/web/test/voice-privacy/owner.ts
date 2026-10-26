import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import type { VoiceOwner } from "@t3tools/client-runtime/realtime-voice";

export const harnessOwner = (): VoiceOwner => ({
  environmentId: EnvironmentId.make("env-harness"),
  threadId: ThreadId.make("thread-harness"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerThreadId: ProviderThreadId.make("provider-thread-harness"),
  providerSessionId: ProviderSessionId.make("provider-session-harness"),
  threadTitle: "Harness",
  environmentLabel: "Harness",
  accountId: null,
});
