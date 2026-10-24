import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { ProviderRealtimeVoiceError, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { createBrowserVoiceTransport } from "../../voice/browserVoiceTransport";
import {
  isVoiceShortcutCommand,
  voiceShortcutAction,
  type VoiceShortcutCommand,
} from "../../voice/voiceShortcut";
import { randomUUID } from "../../lib/utils";
import {
  createRealtimeVoiceController,
  type RealtimeVoiceController,
  type VoiceOwner,
  type VoiceSnapshot,
} from "@t3tools/client-runtime/realtime-voice";
import { resolveShortcutCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  readVoiceOwner,
  validateVoiceOwner,
  watchVoiceOwner,
} from "../../voice/voiceOwnerLifecycle";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";

const isVoiceError = Schema.is(ProviderRealtimeVoiceError);
function describeError(error: unknown): string {
  if (isVoiceError(error) && typeof error.cause === "string") return error.cause;
  return error instanceof Error ? error.message : String(error);
}
function requireSuccess<A, E>(result: AtomCommandResult<A, E>): A {
  if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
  return result.value;
}
function reportUnavailable(error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Voice unavailable",
      description: describeError(error),
    }),
  );
}
// Re-reads the paused conversation so Resume uses its current provider binding and grants.
function resumeVoice(controller: RealtimeVoiceController) {
  const snapshot = controller.getSnapshot();
  if (snapshot.mode !== "paused") return;
  try {
    const owner = readVoiceOwner(snapshot.owner.environmentId, snapshot.owner.threadId);
    void controller.resume(owner).catch(reportUnavailable);
  } catch (error) {
    reportUnavailable(error);
  }
}
function runVoiceShortcut(
  controller: RealtimeVoiceController,
  command: VoiceShortcutCommand,
  mayResume: boolean,
) {
  const action = voiceShortcutAction(controller.getSnapshot().mode, command, mayResume);
  if (action === "end") controller.end();
  else if (action === "pause") controller.pause();
  else if (action === "resume") resumeVoice(controller);
}

interface VoiceContext {
  readonly snapshot: VoiceSnapshot;
  readonly start: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly move: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly end: () => void;
  readonly returnToOwner: (owner: VoiceOwner) => void;
}
const Context = createContext<VoiceContext | null>(null);

export function RealtimeVoiceProvider({
  children,
  returnToOwner,
}: {
  readonly children: ReactNode;
  readonly returnToOwner: (owner: VoiceOwner) => void;
}) {
  const startProvider = useOrchestrationCommand(threadEnvironment.startRealtimeVoice, {
    reportFailure: false,
  });
  const stopProvider = useOrchestrationCommand(threadEnvironment.stopRealtimeVoice, {
    reportFailure: false,
  });
  const [controller] = useState(() =>
    createRealtimeVoiceController({
      createTransport: createBrowserVoiceTransport,
      createOperationId: randomUUID,
      validateOwner: validateVoiceOwner,
      now: () => Date.now(),
      scheduleExpiry: (expiresAt, expired) => {
        const timeout = window.setTimeout(expired, Math.max(0, expiresAt - Date.now()));
        return () => window.clearTimeout(timeout);
      },
      startProvider: async (owner, sdp) =>
        requireSuccess(
          await startProvider({
            environmentId: owner.environmentId,
            input: { threadId: owner.threadId, operationId: owner.operationId, sdp },
          }),
        ),
      stopProvider: async (owner, ownership) => {
        requireSuccess(
          await stopProvider({
            environmentId: owner.environmentId,
            input: {
              threadId: owner.threadId,
              operationId: ownership.operationId,
              voiceSessionToken: ownership.voiceSessionToken,
              providerThreadId: ownership.providerThreadId,
              providerSessionId: ownership.providerSessionId,
            },
          }),
        );
      },
      describeError,
      watchOwner: watchVoiceOwner,
    }),
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    let previous = controller.getSnapshot();
    return controller.subscribe(() => {
      const next = controller.getSnapshot();
      const failedOwner = previous.owner;
      const ended = previous.mode !== "off" && next.mode === "off";
      previous = next;
      if (ended && next.reason !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failedOwner ? `Voice ended in ${failedOwner.threadTitle}` : "Voice ended",
            description: next.reason,
          }),
        );
      }
    });
  }, [controller]);
  useEffect(() => {
    const end = () => controller.end("Voice ended because the app is closing or suspended.");
    // Desktop voice outlives a hidden window; screen lock and sleep pause it instead.
    // Window blur never pauses: talking while using another app is the point.
    const hidden = () => {
      if (!window.desktopBridge && document.visibilityState === "hidden") {
        controller.pause("Paused because this browser tab was hidden.");
      }
    };
    const offline = () => controller.end("Voice ended because the network became unavailable.");
    const stopDesktopPause = window.desktopBridge?.onVoicePrivacyPause?.(() =>
      controller.pause("Paused because this computer locked or went to sleep."),
    );
    // Chords claimed inside a focused Browser-panel guest arrive as menu actions. Agents can type
    // into a guest, so these can only revoke.
    const stopForwarded = window.desktopBridge?.onMenuAction((action) => {
      if (isVoiceShortcutCommand(action)) runVoiceShortcut(controller, action, false);
    });
    window.addEventListener("pagehide", end);
    window.addEventListener("offline", offline);
    document.addEventListener("freeze", end);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      end();
      stopDesktopPause?.();
      stopForwarded?.();
      window.removeEventListener("pagehide", end);
      window.removeEventListener("offline", offline);
      document.removeEventListener("freeze", end);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [controller]);
  // Separate from the lifecycle effect, whose cleanup ends voice, so remapping never ends a call.
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || controller.getSnapshot().mode === "off") return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { voiceActive: true },
      });
      if (!isVoiceShortcutCommand(command)) return;
      event.preventDefault();
      // A rendered page's keys are replayed as untrusted events; they cannot resume.
      if (!event.repeat) runVoiceShortcut(controller, command, event.isTrusted);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [controller, keybindings]);
  const invoke = (environmentId: EnvironmentId, threadId: ThreadId, moving: boolean) => {
    try {
      const owner = readVoiceOwner(environmentId, threadId);
      void (moving ? controller.move(owner) : controller.start(owner)).catch(reportUnavailable);
    } catch (error) {
      reportUnavailable(error);
    }
  };
  return (
    <Context
      value={{
        snapshot,
        start: (environmentId, threadId) => invoke(environmentId, threadId, false),
        move: (environmentId, threadId) => invoke(environmentId, threadId, true),
        pause: () => controller.pause(),
        resume: () => resumeVoice(controller),
        end: () => controller.end(),
        returnToOwner,
      }}
    >
      {children}
    </Context>
  );
}

export function useRealtimeVoice(): VoiceContext {
  const value = useContext(Context);
  if (value === null) throw new Error("Realtime voice controls require the app voice provider.");
  return value;
}

/** Whether a voice session exists. Unlike `useRealtimeVoice`, safe to call without the provider. */
export function useRealtimeVoiceActive(): boolean {
  const value = useContext(Context);
  return value !== null && value.snapshot.mode !== "off";
}
