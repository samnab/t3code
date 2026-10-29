import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type CompletionAudioMode,
  type ServerConfig,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadCompletionAudioForDisplay } from "./thread-settings-options";

/**
 * Completion audio and reload-agent controls for an existing thread's settings sheet.
 * Spread the result into `ThreadSettingsPickerScreen`.
 */
export function useExistingThreadSettingsControls(input: {
  readonly thread: EnvironmentThreadShell | null;
  readonly serverConfig: ServerConfig | null;
  readonly connectionState: EnvironmentConnectionPhase | null;
}) {
  const { thread } = input;
  const setCompletionAudio = useAtomCommand(threadEnvironment.setCompletionAudio, {
    label: "set thread completion audio",
    reportFailure: false,
  });
  const setVoiceNotifications = useAtomCommand(threadEnvironment.setVoiceNotifications, {
    label: "set thread voice notifications",
    reportFailure: false,
  });
  const stopSession = useAtomCommand(threadEnvironment.stopSession, "reload agent");
  const canUpdateCompletionAudio = useEnvironmentScope(
    thread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  if (!thread) return {};
  const supportsCompletionSound =
    input.serverConfig?.environment.capabilities.completionNotifications === true;

  const onUpdateCompletionAudio = async (mode: CompletionAudioMode) => {
    if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
    const result = supportsCompletionSound
      ? await setCompletionAudio({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, mode },
        })
      : await setVoiceNotifications({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, voiceNotifications: mode === "voice" },
        });
    if (AsyncResult.isFailure(result))
      Dialog.alert("Could not update completion audio", String(Cause.squash(result.cause)));
  };

  // Stopping the provider keeps the conversation: the next message resumes it in a fresh process.
  const reloadAgent =
    thread.runtime === null
      ? undefined
      : {
          disabled:
            input.connectionState !== "connected" || !threadRuntimeCanArchive(thread.runtime),
          onPress: () =>
            Dialog.alert(
              "Reload agent?",
              "The next message will resume this thread in a fresh agent process.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Reload",
                  onPress: () => {
                    void stopSession({
                      environmentId: thread.environmentId,
                      input: { threadId: thread.id },
                    });
                  },
                },
              ],
            ),
        };

  return {
    completionAudio: threadCompletionAudioForDisplay(thread, supportsCompletionSound),
    supportsCompletionSound,
    canUpdateCompletionAudio,
    onUpdateCompletionAudio,
    ...(reloadAgent ? { reloadAgent } : {}),
  };
}
