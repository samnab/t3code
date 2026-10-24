import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { VoiceOwner } from "@t3tools/client-runtime/realtime-voice";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentPresentations } from "../../state/presentation";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";

// Mirrors apps/web/src/voice/voiceOwnerLifecycle.ts against the mobile atom registry.
export function readVoiceOwner(environmentId: EnvironmentId, threadId: ThreadId): VoiceOwner {
  const thread = appAtomRegistry.get(
    environmentThreadShells.threadShellAtom({ environmentId, threadId }),
  );
  const environment = appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId));
  if (
    thread === null ||
    thread.deletedAt !== null ||
    environment === null ||
    !environment.entry.enabled ||
    environment.connection.phase !== "connected" ||
    !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
  ) {
    throw new Error("Voice needs a connected, authorized conversation.");
  }
  if (thread.activeProviderThreadId === null) {
    throw new Error("Send a message in this conversation before starting voice.");
  }
  const detail = appAtomRegistry.get(
    environmentThreadDetails.stateAtom({ environmentId, threadId }),
  );
  const projection = Option.getOrNull(detail.data);
  if (detail.status === "deleted" || Option.isSome(detail.error)) {
    throw new Error("The voice conversation is unavailable.");
  }
  const providerThread = projection?.providerThreads.find(
    (provider) => provider.id === thread.activeProviderThreadId,
  );
  const providerSessionId = providerThread?.providerSessionId;
  const session = projection?.providerSessions.find(
    (candidate) => candidate.id === providerSessionId,
  );
  if (
    !providerSessionId ||
    !session ||
    session.status === "stopped" ||
    session.status === "error" ||
    providerThread?.status === "closed" ||
    providerThread?.status === "error"
  ) {
    throw new Error(
      "Voice needs a loaded provider session. Send a message in this conversation first.",
    );
  }
  if (session.driver !== "codex") {
    throw new Error("Realtime voice is currently available for loaded Codex conversations.");
  }
  return {
    environmentId,
    threadId,
    providerInstanceId: thread.providerInstanceId,
    providerThreadId: thread.activeProviderThreadId,
    providerSessionId,
    threadTitle: thread.title || "Untitled conversation",
    environmentLabel: environment.entry.target.label,
    accountId: appAtomRegistry.get(managedRelaySessionAtom)?.accountId ?? null,
  };
}

export function validateVoiceOwner(owner: VoiceOwner): void {
  const current = readVoiceOwner(owner.environmentId, owner.threadId);
  if (
    current.providerInstanceId !== owner.providerInstanceId ||
    current.providerThreadId !== owner.providerThreadId ||
    current.providerSessionId !== owner.providerSessionId ||
    current.accountId !== owner.accountId
  ) {
    throw new Error(
      "The conversation's provider or account changed. Select it again before starting voice.",
    );
  }
}

/** Keep subscriptions on the originating environment even when its screen is gone. */
export function watchVoiceOwner(owner: VoiceOwner, lost: (reason: string) => void): () => void {
  const accountId = owner.accountId;
  const validate = () => {
    try {
      const current = readVoiceOwner(owner.environmentId, owner.threadId);
      if (
        current.providerInstanceId !== owner.providerInstanceId ||
        current.providerThreadId !== owner.providerThreadId ||
        current.providerSessionId !== owner.providerSessionId
      ) {
        lost("Voice ended because the conversation's provider changed.");
      }
      if ((appAtomRegistry.get(managedRelaySessionAtom)?.accountId ?? null) !== accountId) {
        lost("Voice ended because the signed-in account changed.");
      }
    } catch {
      lost("Voice ended because its conversation, connection, or permission is unavailable.");
    }
  };
  const cleanups = [
    appAtomRegistry.subscribe(environmentThreadDetails.stateAtom(owner), validate),
    appAtomRegistry.subscribe(environmentThreadShells.threadShellAtom(owner), validate),
    appAtomRegistry.subscribe(
      environmentPresentations.presentationAtom(owner.environmentId),
      validate,
    ),
    appAtomRegistry.subscribe(environmentSession.sessionStateAtom(owner.environmentId), validate),
    appAtomRegistry.subscribe(managedRelaySessionAtom, validate),
  ];
  validate();
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
