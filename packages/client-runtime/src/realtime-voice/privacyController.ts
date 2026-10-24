import * as DateTime from "effect/DateTime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderRealtimeVoiceStartResult,
  ThreadId,
} from "@t3tools/contracts";

export interface VoiceOwner {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly threadTitle: string;
  readonly environmentLabel: string;
  readonly accountId: string | null;
}

export interface VoiceOperationOwner extends VoiceOwner {
  readonly operationId: string;
}

export interface VoiceSessionOwnership {
  readonly operationId: string;
  readonly voiceSessionToken: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly expiresAt: string;
}

/** One peer per operation. The sender starts gated shut and carries only gated output, never the
 * raw microphone track. `enableMicrophone` opens the gate; `close` shuts it synchronously before
 * releasing capture, peer and playback, and is never reopened. */
export interface VoiceTransport {
  acquireMicrophone(): Promise<void>;
  createOffer(): Promise<string>;
  setLocalDescription(offer: string): Promise<void>;
  gatherIce(): Promise<void>;
  localSdp(): string;
  setRemoteDescription(sdp: string): Promise<void>;
  isConnected(): boolean;
  enableMicrophone(): void;
  close(): void;
}

export const VOICE_REPLACEMENT_GATE =
  "Microphone off. The host has not confirmed that this call closed. New calls remain blocked.";
const VOICE_OWNERSHIP_REQUIRED =
  "Microphone off. This host did not return matching voice ownership. Update the T3 host before starting another call.";
const MAX_VOICE_LIFETIME_MS = 4 * 60 * 60 * 1_000;
class VoiceOwnershipUnavailable extends Error {
  constructor() {
    super(VOICE_OWNERSHIP_REQUIRED);
  }
}

type VoiceState = {
  readonly reason: string | null;
  readonly replacementBlocked: boolean;
  readonly expiresAt: string | null;
};
/**
 * Pause and Mic off revoke the microphone the same way: locally first, then the provider stop.
 * Pause ("pausing" → "paused") keeps the conversation so Resume can start a fresh call in it.
 * Mic off ("ending" → "off") forgets the conversation; nothing can resume it.
 */
export type VoiceSnapshot = VoiceState &
  (
    | { readonly mode: "off"; readonly owner: null }
    | {
        readonly mode: "connecting" | "transmitting" | "pausing" | "paused" | "ending";
        readonly owner: VoiceOperationOwner;
      }
  );

interface Attempt {
  readonly owner: VoiceOperationOwner;
  readonly generation: number;
  readonly startedAt: number;
  readonly finished: Promise<boolean>;
  readonly resolveFinished: (safe: boolean) => void;
  transport: VoiceTransport | null;
  ownership: VoiceSessionOwnership | null;
  cancelled: boolean;
  remoteRequested: boolean;
  descriptionReady: boolean;
  stopRequested: boolean;
  capturePending: boolean;
  pause: boolean;
  reason: string | null;
  releaseOwner: (() => void) | null;
  cancelExpiry: (() => void) | null;
  expiresAt: number | null;
}

function readOwnership(
  owner: VoiceOperationOwner,
  result: ProviderRealtimeVoiceStartResult,
): VoiceSessionOwnership {
  if (
    result.operationId !== owner.operationId ||
    !result.voiceSessionToken ||
    result.providerInstanceId === undefined ||
    result.providerThreadId === undefined ||
    result.providerSessionId === undefined ||
    result.expiresAt === undefined ||
    !Number.isFinite(Date.parse(result.expiresAt))
  ) {
    throw new VoiceOwnershipUnavailable();
  }
  return Object.freeze({
    operationId: result.operationId,
    voiceSessionToken: result.voiceSessionToken,
    providerInstanceId: result.providerInstanceId,
    providerThreadId: result.providerThreadId,
    providerSessionId: result.providerSessionId,
    expiresAt: result.expiresAt,
  });
}

/** The shared mode/generation/owner authority. Platform transports enforce local teardown.
 * Pause releases the microphone as well: local-only listening needs an on-device detector and is
 * deliberately unavailable here. No remote input can call `resume`. */
export function createRealtimeVoiceController(deps: {
  readonly createTransport: (events: {
    connected(): void;
    failed(reason: string): void;
  }) => VoiceTransport;
  readonly createOperationId: () => string;
  readonly validateOwner: (owner: VoiceOwner) => void;
  readonly startProvider: (
    owner: VoiceOperationOwner,
    sdp: string,
  ) => Promise<ProviderRealtimeVoiceStartResult>;
  readonly stopProvider: (
    owner: VoiceOperationOwner,
    ownership: VoiceSessionOwnership,
  ) => Promise<void>;
  readonly describeError: (error: unknown) => string;
  readonly watchOwner: (owner: VoiceOwner, lost: (reason: string) => void) => () => void;
  readonly now: () => number;
  readonly scheduleExpiry: (expiresAt: number, expired: () => void) => () => void;
}) {
  let snapshot: VoiceSnapshot = {
    mode: "off",
    owner: null,
    reason: null,
    replacementBlocked: false,
    expiresAt: null,
  };
  let generation = 0;
  let attempt: Attempt | null = null;
  let moveIntent: object | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: VoiceSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const current = (value: Attempt) =>
    attempt === value && !value.cancelled && value.generation === generation;
  const releaseOwner = (value: Attempt) => {
    const release = value.releaseOwner;
    value.releaseOwner = null;
    release?.();
  };
  const finish = (value: Attempt, safe: boolean) => {
    if (attempt !== value) return;
    value.cancelExpiry?.();
    value.cancelExpiry = null;
    releaseOwner(value);
    attempt = null;
    const state = { reason: value.reason, replacementBlocked: !safe, expiresAt: null };
    publish(
      value.pause
        ? { ...state, mode: "paused", owner: value.owner }
        : { ...state, mode: "off", owner: null },
    );
    value.resolveFinished(safe);
  };
  const stopRemote = async (value: Attempt) => {
    if (value.stopRequested || value.ownership === null) return;
    value.stopRequested = true;
    try {
      // Modern stop only succeeds after the host's native-close barrier, not merely a stop request ack.
      await deps.stopProvider(value.owner, value.ownership);
      finish(value, true);
    } catch (error) {
      value.reason = [value.reason, VOICE_REPLACEMENT_GATE, deps.describeError(error)]
        .filter(Boolean)
        .join(" ");
      finish(value, false);
    }
  };
  const cancelAttempt = (reason: string | null = null, pause = false) => {
    const value = attempt;
    if (value === null || value.cancelled) return;
    value.cancelled = true;
    value.pause = pause;
    value.reason = reason;
    generation += 1;
    // Local capture and playback stop before entering the serialized RPC queue.
    value.transport?.close();
    value.cancelExpiry?.();
    value.cancelExpiry = null;
    publish({
      mode: pause ? "pausing" : "ending",
      owner: value.owner,
      reason,
      replacementBlocked: value.remoteRequested,
      expiresAt: snapshot.expiresAt,
    });
    if (!value.remoteRequested && !value.capturePending) finish(value, true);
    else if (value.ownership !== null) void stopRemote(value);
  };
  /** Mic off. Overrides a pending pause and forgets a paused conversation. */
  const end = (reason: string | null = null) => {
    moveIntent = null;
    const value = attempt;
    if (value === null) {
      if (snapshot.mode === "paused") {
        publish({
          mode: "off",
          owner: null,
          // A blocked replacement keeps explaining why new calls stay blocked.
          reason: reason ?? (snapshot.replacementBlocked ? snapshot.reason : null),
          replacementBlocked: snapshot.replacementBlocked,
          expiresAt: null,
        });
      }
      return;
    }
    if (!value.cancelled) {
      cancelAttempt(reason);
      return;
    }
    const nextReason = value.reason ?? reason;
    if (!value.pause && nextReason === value.reason) return;
    value.pause = false;
    value.reason = nextReason;
    publish({
      mode: "ending",
      owner: value.owner,
      reason: nextReason,
      replacementBlocked: snapshot.replacementBlocked,
      expiresAt: snapshot.expiresAt,
    });
  };
  /** Privacy pause. Revokes like Mic off, then lands in "paused" once the provider stop settles. */
  const pause = (reason: string | null = null) => {
    moveIntent = null;
    cancelAttempt(reason, true);
  };
  const markConnected = (value: Attempt) => {
    if (!current(value) || !value.descriptionReady || !value.transport?.isConnected()) return;
    if (value.expiresAt === null || deps.now() >= value.expiresAt) {
      end("Voice reached its time limit. Start a new call explicitly.");
      return;
    }
    value.transport.enableMicrophone();
    publish({
      mode: "transmitting",
      owner: value.owner,
      reason: null,
      replacementBlocked: false,
      expiresAt: DateTime.formatIso(DateTime.makeUnsafe(value.expiresAt)),
    });
  };
  const start = async (owner: VoiceOwner) => {
    if (attempt !== null || snapshot.replacementBlocked) return;
    deps.validateOwner(owner);
    const operationId = deps.createOperationId();
    let resolveFinished: (safe: boolean) => void = () => {};
    const finished = new Promise<boolean>((resolve) => {
      resolveFinished = resolve;
    });
    const value: Attempt = {
      owner: Object.freeze({ ...owner, operationId }),
      generation: ++generation,
      startedAt: deps.now(),
      finished,
      resolveFinished,
      transport: null,
      ownership: null,
      cancelled: false,
      remoteRequested: false,
      descriptionReady: false,
      stopRequested: false,
      capturePending: false,
      pause: false,
      reason: null,
      releaseOwner: null,
      cancelExpiry: null,
      expiresAt: null,
    };
    attempt = value;
    publish({
      mode: "connecting",
      owner: value.owner,
      reason: null,
      replacementBlocked: false,
      expiresAt: null,
    });
    try {
      value.releaseOwner = deps.watchOwner(value.owner, (reason) => {
        if (attempt === value) end(reason);
      });
      if (!current(value)) {
        releaseOwner(value);
        return;
      }
      const transport = deps.createTransport({
        connected: () => markConnected(value),
        failed: (reason) => {
          if (current(value)) end(reason);
        },
      });
      value.transport = transport;
      value.capturePending = true;
      try {
        await transport.acquireMicrophone();
      } finally {
        value.capturePending = false;
      }
      if (!current(value)) return;
      const offer = await transport.createOffer();
      if (!current(value)) return;
      await transport.setLocalDescription(offer);
      if (!current(value)) return;
      await transport.gatherIce();
      if (!current(value)) return;
      const offerSdp = transport.localSdp();
      value.remoteRequested = true;
      const result = await deps.startProvider(value.owner, offerSdp);
      if (attempt !== value) return;
      value.ownership = readOwnership(value.owner, result);
      if (
        value.ownership.providerInstanceId !== value.owner.providerInstanceId ||
        value.ownership.providerThreadId !== value.owner.providerThreadId ||
        value.ownership.providerSessionId !== value.owner.providerSessionId
      ) {
        // This operation owns the returned binding for cleanup, but cannot authorize its audio.
        end(
          value.reason ??
            "Microphone off. The conversation's provider changed during voice startup.",
        );
        void stopRemote(value);
        return;
      }
      if (!current(value)) {
        void stopRemote(value);
        return;
      }
      value.expiresAt = Math.min(
        Date.parse(value.ownership.expiresAt),
        value.startedAt + MAX_VOICE_LIFETIME_MS,
      );
      if (deps.now() >= value.expiresAt) {
        end("Voice reached its time limit. Start a new call explicitly.");
        return;
      }
      publish({
        mode: "connecting",
        owner: value.owner,
        reason: null,
        replacementBlocked: false,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(value.expiresAt)),
      });
      if (!current(value)) return;
      value.cancelExpiry = deps.scheduleExpiry(value.expiresAt, () => {
        if (current(value)) end("Voice reached its time limit. Start a new call explicitly.");
      });
      await transport.setRemoteDescription(result.sdp);
      if (!current(value)) return;
      value.descriptionReady = true;
      markConnected(value);
    } catch (error) {
      if (attempt !== value) return;
      if (!value.cancelled) cancelAttempt(deps.describeError(error));
      // Missing/mismatched ownership and ambiguous start failure never authorize a legacy stop.
      if (value.ownership === null) {
        if (value.remoteRequested)
          value.reason =
            error instanceof VoiceOwnershipUnavailable
              ? VOICE_OWNERSHIP_REQUIRED
              : `${VOICE_REPLACEMENT_GATE} ${deps.describeError(error)}`;
        finish(value, !value.remoteRequested);
      }
    } finally {
      // getUserMedia cannot be aborted. Its reservation lasts until the late stream is stopped.
      if (value.cancelled && !value.remoteRequested) finish(value, true);
    }
  };
  const move = async (owner: VoiceOwner) => {
    deps.validateOwner(owner);
    if (
      snapshot.replacementBlocked ||
      moveIntent !== null ||
      snapshot.mode === "ending" ||
      snapshot.mode === "pausing"
    )
      return;
    const source = attempt;
    if (source === null) {
      await start(owner);
      return;
    }
    if (
      source.owner.environmentId === owner.environmentId &&
      source.owner.threadId === owner.threadId
    )
      return;
    const destination = Object.freeze({ ...owner });
    const intent = {};
    moveIntent = intent;
    cancelAttempt();
    const safe = await source.finished;
    if (moveIntent !== intent) return;
    moveIntent = null;
    if (!safe || attempt !== null || snapshot.replacementBlocked) return;
    // Grants and destination provider identity may change while A's native-close barrier settles.
    deps.validateOwner(destination);
    await start(destination);
  };
  /**
   * The only way out of pause, and only from a local user action: a new operation, peer and
   * microphone grant for the paused conversation. Nothing captured before or during the pause
   * survives into it. Pass a freshly read owner; a failed check leaves voice paused.
   */
  const resume = async (owner: VoiceOwner) => {
    if (
      snapshot.mode !== "paused" ||
      snapshot.owner.environmentId !== owner.environmentId ||
      snapshot.owner.threadId !== owner.threadId
    )
      return;
    await start(owner);
  };
  return {
    start,
    move,
    end,
    pause,
    resume,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type RealtimeVoiceController = ReturnType<typeof createRealtimeVoiceController>;
