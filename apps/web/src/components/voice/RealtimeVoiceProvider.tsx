import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { ProviderRealtimeVoiceError, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { createBrowserVoiceTransport } from "../../voice/browserVoiceTransport";
import {
  createRealtimeVoiceController,
  type VoiceOwner,
  type VoiceSnapshot,
} from "@t3tools/client-runtime/realtime-voice";
import { readVoiceOwner, watchVoiceOwner } from "../../voice/voiceOwnerLifecycle";
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

interface VoiceContext {
  readonly snapshot: VoiceSnapshot;
  readonly start: (environmentId: EnvironmentId, threadId: ThreadId) => void;
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
      startProvider: async (owner, sdp) =>
        requireSuccess(
          await startProvider({
            environmentId: owner.environmentId,
            input: { threadId: owner.threadId, sdp },
          }),
        ).sdp,
      stopProvider: async (owner) => {
        const current = readVoiceOwner(owner.environmentId, owner.threadId);
        if (
          current.providerInstanceId !== owner.providerInstanceId ||
          current.providerThreadId !== owner.providerThreadId ||
          current.providerSessionId !== owner.providerSessionId
        ) {
          throw new Error("Provider ownership changed; the thread-only stop was withheld.");
        }
        requireSuccess(
          await stopProvider({
            environmentId: owner.environmentId,
            input: { threadId: owner.threadId },
          }),
        );
      },
      describeError,
      watchOwner: watchVoiceOwner,
    }),
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    const end = () => controller.end("Voice ended because the app is closing or suspended.");
    const hidden = () => {
      if (!window.desktopBridge && document.visibilityState === "hidden") {
        controller.end("Microphone off because this browser tab was hidden.");
      }
    };
    const offline = () => controller.end("Voice ended because the network became unavailable.");
    window.addEventListener("pagehide", end);
    window.addEventListener("offline", offline);
    document.addEventListener("freeze", end);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      end();
      window.removeEventListener("pagehide", end);
      window.removeEventListener("offline", offline);
      document.removeEventListener("freeze", end);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [controller]);
  const start = (environmentId: EnvironmentId, threadId: ThreadId) => {
    try {
      void controller.start(readVoiceOwner(environmentId, threadId));
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Voice unavailable",
          description: describeError(error),
        }),
      );
    }
  };
  return (
    <Context value={{ snapshot, start, end: () => controller.end(), returnToOwner }}>
      {children}
    </Context>
  );
}

export function useRealtimeVoice(): VoiceContext {
  const value = useContext(Context);
  if (value === null) throw new Error("Realtime voice controls require the app voice provider.");
  return value;
}
