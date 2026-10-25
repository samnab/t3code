import type { VoiceOwner } from "@t3tools/client-runtime/realtime-voice";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type {
  RealtimeVoiceAudio,
  RealtimeVoiceAudioRevoked,
} from "../../native/realtimeVoiceAudio";
import { createMicrophoneArbiter } from "./microphoneArbiter";
import type { MobileVoiceTransportFactory } from "./nativeVoiceTransport";
import {
  createMobileRealtimeVoiceOwner,
  VOICE_BLOCKED_BY_DICTATION,
  VOICE_UNAVAILABLE,
  type MobileRealtimeVoiceOwner,
} from "./realtimeVoiceOwner";

const OWNER: VoiceOwner = {
  environmentId: EnvironmentId.make("env-a"),
  threadId: ThreadId.make("thread-a"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerThreadId: ProviderThreadId.make("native-a"),
  providerSessionId: ProviderSessionId.make("session-a"),
  threadTitle: "Conversation A",
  environmentLabel: "Machine A",
  accountId: null,
};

function setup(options: { readonly withTransport?: boolean } = {}) {
  const revokedListeners = new Set<(event: RealtimeVoiceAudioRevoked) => void>();
  const audio: RealtimeVoiceAudio = {
    prepare: async () => 7,
    openGate: () => 1,
    renewLease: () => true,
    closeGate: () => true,
    end: async () => true,
    snapshot: () => ({
      installed: true,
      adopted: true,
      owned: true,
      generation: 7,
      armed: true,
      epoch: 1,
    }),
    addRevokedListener: (listener) => {
      revokedListeners.add(listener);
      return { remove: () => revokedListeners.delete(listener) };
    },
  };
  const nativeOwners: string[] = [];
  const closed = vi.fn();
  const transport = vi.fn<MobileVoiceTransportFactory>((nativeAudio, nativeOwner, events) => {
    nativeOwners.push(nativeOwner);
    return {
      acquireMicrophone: async () => {
        events.prepared(await nativeAudio.prepare(nativeOwner));
      },
      createOffer: async () => "offer",
      setLocalDescription: async () => {},
      gatherIce: async () => {},
      localSdp: () => "offer",
      setRemoteDescription: async () => {},
      isConnected: () => true,
      enableMicrophone: () => {},
      close: closed,
    };
  });
  const stopProvider = vi.fn(async () => {});
  const arbiter = createMicrophoneArbiter();
  let sequence = 0;
  const owner = createMobileRealtimeVoiceOwner({
    audio,
    transport: options.withTransport === false ? null : transport,
    arbiter,
    createOperationId: () => `operation-${++sequence}`,
    validateOwner: () => {},
    watchOwner: () => () => {},
    now: () => Date.parse("2026-10-24T10:00:00.000Z"),
    scheduleExpiry: () => () => {},
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
    startProvider: async (operationOwner) => ({
      sdp: "answer",
      operationId: operationOwner.operationId,
      voiceSessionToken: `token-${operationOwner.operationId}`,
      providerInstanceId: operationOwner.providerInstanceId,
      providerThreadId: operationOwner.providerThreadId,
      providerSessionId: operationOwner.providerSessionId,
      expiresAt: "2026-10-24T11:00:00.000Z",
    }),
    stopProvider,
  });
  const revoke = (event: RealtimeVoiceAudioRevoked) => {
    for (const listener of revokedListeners) listener(event);
  };
  return {
    owner,
    arbiter,
    transport,
    nativeOwners,
    closed,
    stopProvider,
    revoke,
    revokedListeners,
  };
}

function untilOff(owner: MobileRealtimeVoiceOwner): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = owner.subscribe(() => {
      if (owner.getSnapshot().mode !== "off") return;
      unsubscribe();
      resolve();
    });
  });
}

describe("createMobileRealtimeVoiceOwner", () => {
  it("rejects start without a transport and leaves the microphone unclaimed", async () => {
    const { owner, arbiter } = setup({ withTransport: false });

    expect(owner.available).toBe(false);
    await expect(owner.start(OWNER)).rejects.toThrow(VOICE_UNAVAILABLE);
    expect(owner.getSnapshot().mode).toBe("off");
    expect(arbiter.holder()).toBeNull();
  });

  it("ends the session on a matching native revocation and never restarts on its own", async () => {
    const {
      owner,
      arbiter,
      transport,
      nativeOwners,
      closed,
      stopProvider,
      revoke,
      revokedListeners,
    } = setup();
    await owner.start(OWNER);
    expect(owner.getSnapshot().mode).toBe("transmitting");
    const [nativeOwner] = nativeOwners;
    if (nativeOwner === undefined) throw new Error("transport was not created");

    revoke({ reason: "audioFault", owner: nativeOwner, generation: 6 });
    revoke({ reason: "audioFault", owner: "someone-else", generation: 7 });
    expect(owner.getSnapshot().mode).toBe("transmitting");

    const off = untilOff(owner);
    revoke({ reason: "audioFault", owner: nativeOwner, generation: 7 });
    await off;

    expect(owner.getSnapshot()).toMatchObject({
      mode: "off",
      replacementBlocked: false,
      reason: "Microphone off. The audio device failed. Start a new call when ready.",
    });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(stopProvider).toHaveBeenCalledTimes(1);
    expect(revokedListeners.size).toBe(0);
    expect(arbiter.holder()).toBeNull();

    revoke({ reason: "audioFault", owner: nativeOwner, generation: 7 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(owner.getSnapshot().mode).toBe("off");
  });

  it("keeps dictation and realtime voice off the microphone at the same time", async () => {
    const { owner, arbiter, transport } = setup();

    expect(arbiter.acquire("dictation")).toBe(true);
    await expect(owner.start(OWNER)).rejects.toThrow(VOICE_BLOCKED_BY_DICTATION);
    expect(transport).not.toHaveBeenCalled();
    expect(owner.getSnapshot().mode).toBe("off");
    arbiter.release("dictation");

    await owner.start(OWNER);
    expect(arbiter.holder()).toBe("realtime-voice");
    expect(arbiter.acquire("dictation")).toBe(false);

    const off = untilOff(owner);
    owner.end();
    await off;
    expect(arbiter.acquire("dictation")).toBe(true);
  });
});
