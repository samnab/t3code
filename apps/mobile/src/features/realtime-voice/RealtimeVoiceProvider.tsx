import type { VoiceOwner, VoiceSnapshot } from "@t3tools/client-runtime/realtime-voice";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { ProviderRealtimeVoiceError, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { uuidv4 } from "../../lib/uuid";
import { getRealtimeVoiceAudio } from "../../native/realtimeVoiceAudio";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { microphoneArbiter } from "./microphoneArbiter";
import { returnToVoiceOwner } from "./navigationRef";
import { mobileVoiceTransport } from "./nativeVoiceTransport";
import { createMobileRealtimeVoiceOwner } from "./realtimeVoiceOwner";
import { readVoiceOwner, validateVoiceOwner, watchVoiceOwner } from "./voiceOwnerLifecycle";

const isVoiceError = Schema.is(ProviderRealtimeVoiceError);
function describeError(error: unknown): string {
  if (isVoiceError(error) && typeof error.cause === "string") return error.cause;
  return error instanceof Error ? error.message : String(error);
}
function requireSuccess<A, E>(result: AtomCommandResult<A, E>): A {
  if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
  return result.value;
}

interface RealtimeVoiceContext {
  readonly snapshot: VoiceSnapshot;
  /** False until the native gated transport ships; callers hide Start instead of faking a call. */
  readonly available: boolean;
  /** Rejects with a user-facing message when voice cannot start. */
  readonly start: (environmentId: EnvironmentId, threadId: ThreadId) => Promise<void>;
  readonly end: () => void;
  readonly returnToOwner: (owner: VoiceOwner) => void;
}
const Context = createContext<RealtimeVoiceContext | null>(null);

/** App-level realtime voice owner. Mount once above navigation so calls outlive screens. */
export function RealtimeVoiceProvider({ children }: { readonly children: ReactNode }) {
  const startProvider = useAtomCommand(threadEnvironment.startRealtimeVoice, {
    reportFailure: false,
  });
  const stopProvider = useAtomCommand(threadEnvironment.stopRealtimeVoice, {
    reportFailure: false,
  });
  const [owner] = useState(() =>
    createMobileRealtimeVoiceOwner({
      audio: getRealtimeVoiceAudio(),
      transport: mobileVoiceTransport,
      arbiter: microphoneArbiter,
      createOperationId: uuidv4,
      validateOwner: validateVoiceOwner,
      watchOwner: watchVoiceOwner,
      now: () => Date.now(),
      scheduleExpiry: (expiresAt, expired) => {
        const timeout = setTimeout(expired, Math.max(0, expiresAt - Date.now()));
        return () => clearTimeout(timeout);
      },
      startProvider: async (voiceOwner, sdp) =>
        requireSuccess(
          await startProvider({
            environmentId: voiceOwner.environmentId,
            input: { threadId: voiceOwner.threadId, operationId: voiceOwner.operationId, sdp },
          }),
        ),
      stopProvider: async (voiceOwner, ownership) => {
        requireSuccess(
          await stopProvider({
            environmentId: voiceOwner.environmentId,
            input: {
              threadId: voiceOwner.threadId,
              operationId: ownership.operationId,
              voiceSessionToken: ownership.voiceSessionToken,
              providerThreadId: ownership.providerThreadId,
              providerSessionId: ownership.providerSessionId,
            },
          }),
        );
      },
      describeError,
    }),
  );
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  useEffect(() => () => owner.end("Voice ended because the app closed."), [owner]);
  return (
    <Context
      value={{
        snapshot,
        available: owner.available,
        start: async (environmentId, threadId) => {
          try {
            await owner.start(readVoiceOwner(environmentId, threadId));
          } catch (error) {
            throw new Error(describeError(error), { cause: error });
          }
        },
        end: () => owner.end(),
        returnToOwner: returnToVoiceOwner,
      }}
    >
      {children}
    </Context>
  );
}

export function useRealtimeVoice(): RealtimeVoiceContext {
  const value = use(Context);
  if (value === null) throw new Error("Realtime voice controls require the app voice provider.");
  return value;
}
