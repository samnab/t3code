import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
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
}

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
  "Microphone off. Starting another call is unavailable until voice sessions support ownership-safe stop.";

export type VoiceSnapshot =
  | {
      readonly mode: "off";
      readonly owner: null;
      readonly reason: string | null;
      readonly replacementBlocked: boolean;
    }
  | {
      readonly mode: "connecting" | "transmitting" | "ending";
      readonly owner: VoiceOwner;
      readonly reason: string | null;
      readonly replacementBlocked: boolean;
    };

interface Attempt {
  readonly owner: VoiceOwner;
  readonly generation: number;
  transport: VoiceTransport | null;
  cancelled: boolean;
  remoteRequested: boolean;
  remoteReady: boolean;
  descriptionReady: boolean;
  stopRequested: boolean;
  releaseOwner: (() => void) | null;
  ownerLost: boolean;
  capturePending: boolean;
}

/** The shared mode/generation/owner authority. Platform transports enforce local teardown.
 * Local-only listening modes require a sample gate and are deliberately unavailable here. */
export function createRealtimeVoiceController(deps: {
  readonly createTransport: (events: {
    connected(): void;
    failed(reason: string): void;
  }) => VoiceTransport;
  readonly startProvider: (owner: VoiceOwner, sdp: string) => Promise<string>;
  readonly stopProvider: (owner: VoiceOwner) => Promise<void>;
  readonly describeError: (error: unknown) => string;
  readonly watchOwner: (owner: VoiceOwner, lost: (reason: string) => void) => () => void;
}) {
  let snapshot: VoiceSnapshot = {
    mode: "off",
    owner: null,
    reason: null,
    replacementBlocked: false,
  };
  let generation = 0;
  let attempt: Attempt | null = null;
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
  const finish = (value: Attempt, reason: string | null) => {
    if (attempt !== value) return;
    releaseOwner(value);
    attempt = null;
    publish({ mode: "off", owner: null, reason, replacementBlocked: value.remoteRequested });
  };
  const stopRemote = async (value: Attempt) => {
    if (value.stopRequested || !value.remoteReady) return;
    value.stopRequested = true;
    if (value.ownerLost) {
      finish(value, snapshot.reason);
      return;
    }
    try {
      await deps.stopProvider(value.owner);
      finish(value, snapshot.reason);
    } catch (error) {
      finish(value, `Microphone off. Provider cleanup failed: ${deps.describeError(error)}`);
    }
  };
  const end = (reason: string | null = null) => {
    const value = attempt;
    if (value === null || value.cancelled) return;
    value.cancelled = true;
    generation += 1;
    // Local capture and playback stop before entering the serialized RPC queue.
    value.transport?.close();
    publish({
      mode: "ending",
      owner: value.owner,
      reason,
      replacementBlocked: value.remoteRequested,
    });
    if (!value.remoteRequested && !value.capturePending) finish(value, reason);
    else if (value.remoteReady) void stopRemote(value);
  };
  const markConnected = (value: Attempt) => {
    if (!current(value) || !value.descriptionReady || !value.transport?.isConnected()) return;
    value.transport.enableMicrophone();
    publish({ mode: "transmitting", owner: value.owner, reason: null, replacementBlocked: true });
  };
  const start = async (owner: VoiceOwner) => {
    if (attempt !== null || snapshot.replacementBlocked) return;
    const value: Attempt = {
      owner: Object.freeze({ ...owner }),
      generation: ++generation,
      transport: null,
      cancelled: false,
      remoteRequested: false,
      remoteReady: false,
      descriptionReady: false,
      stopRequested: false,
      releaseOwner: null,
      ownerLost: false,
      capturePending: false,
    };
    attempt = value;
    publish({ mode: "connecting", owner: value.owner, reason: null, replacementBlocked: false });
    try {
      value.releaseOwner = deps.watchOwner(value.owner, (reason) => {
        if (current(value)) {
          value.ownerLost = true;
          end(reason);
        }
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
      const sdp = await deps.startProvider(value.owner, offerSdp);
      value.remoteReady = true;
      if (!current(value)) {
        void stopRemote(value);
        return;
      }
      await transport.setRemoteDescription(sdp);
      if (!current(value)) return;
      value.descriptionReady = true;
      markConnected(value);
    } catch (error) {
      if (attempt !== value) return;
      if (!value.cancelled) end(`Voice ended: ${deps.describeError(error)}`);
      // A rejected/ambiguous start is not proof that this client owns the provider session.
      // Thread-only stop could terminate a different client's call, so do not issue it.
      if (!value.remoteReady) finish(value, snapshot.reason);
    } finally {
      // getUserMedia cannot be aborted. Keep the reservation until its late stream
      // has been stopped, so another attempt cannot acquire a second microphone.
      if (value.cancelled && !value.remoteRequested) finish(value, snapshot.reason);
    }
  };
  return {
    start,
    end,
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
