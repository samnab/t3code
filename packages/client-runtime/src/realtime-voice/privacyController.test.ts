import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type ProviderRealtimeVoiceStartResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRealtimeVoiceController,
  type RealtimeVoiceController,
  type VoiceOwner,
  type VoiceTransport,
  type VoiceOperationOwner,
  type VoiceSessionOwnership,
} from "./privacyController.ts";

type Stage = "microphone" | "offer" | "local" | "ice" | "provider" | "remote";

function deferred() {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture(holdAt?: Stage, requireMountedOwner = false) {
  const entered = deferred();
  const gate = deferred();
  const operations: string[] = [];
  const transports: Array<
    VoiceTransport & {
      readonly events: { connected(): void; failed(reason: string): void };
      closed: boolean;
      sending: boolean;
      ready: boolean;
    }
  > = [];
  const step = async (stage: Stage, index: number) => {
    operations.push(stage);
    if (index === 0 && holdAt === stage) {
      entered.resolve();
      await gate.promise;
    }
  };
  const owner: VoiceOwner = {
    environmentId: EnvironmentId.make("env-a"),
    threadId: ThreadId.make("thread-a"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: ProviderThreadId.make("native-a"),
    providerSessionId: ProviderSessionId.make("session-a"),
    threadTitle: "Conversation A",
    environmentLabel: "Machine A",
    accountId: null,
  };
  const other: VoiceOwner = {
    ...owner,
    environmentId: EnvironmentId.make("env-b"),
    threadTitle: "Conversation B",
  };
  let ownerLost: (reason: string) => void = () => {};
  let ownerMounted = false;
  const releaseOwner = vi.fn(() => {
    ownerMounted = false;
  });
  const initialNow = Date.parse("2026-10-23T20:00:00.000Z");
  let now = initialNow;
  let sequence = 0;
  const createOperationId = vi.fn(() => `operation-${++sequence}`);
  const validateOwner = vi.fn<(_owner: VoiceOwner) => void>(() => {});
  const expiries: Array<{ at: number; expire: () => void; cancel: ReturnType<typeof vi.fn> }> = [];
  const stopProvider = vi.fn(
    async (_owner: VoiceOperationOwner, _ownership: VoiceSessionOwnership) => {
      if (requireMountedOwner && !ownerMounted) throw new Error("Owner detail was dropped");
      operations.push("stop");
    },
  );
  const startProvider = vi.fn(
    async (owner: VoiceOperationOwner, _sdp: string): Promise<ProviderRealtimeVoiceStartResult> => {
      await step("provider", 0);
      return {
        sdp: "answer",
        operationId: owner.operationId,
        voiceSessionToken: `token-${owner.operationId}`,
        providerInstanceId: owner.providerInstanceId,
        providerThreadId: owner.providerThreadId,
        providerSessionId: owner.providerSessionId,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 4 * 60 * 60 * 1000)),
      };
    },
  );
  const controller = createRealtimeVoiceController({
    createOperationId,
    validateOwner,
    now: () => now,
    scheduleExpiry: (at, expire) => {
      const cancel = vi.fn();
      expiries.push({ at, expire, cancel });
      return cancel;
    },
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
    watchOwner: (_owner, lost) => {
      ownerLost = lost;
      ownerMounted = true;
      return releaseOwner;
    },
    startProvider,
    stopProvider,
    createTransport: (events) => {
      const index = transports.length;
      const transport = {
        events,
        closed: false,
        sending: false,
        ready: true,
        acquireMicrophone: () => step("microphone", index),
        async createOffer() {
          await step("offer", index);
          return "offer";
        },
        setLocalDescription: () => step("local", index),
        gatherIce: () => step("ice", index),
        localSdp: () => "offer",
        setRemoteDescription: () => step("remote", index),
        isConnected: () => transport.ready,
        enableMicrophone: () => {
          transport.sending = true;
        },
        close: () => {
          operations.push("close");
          transport.closed = true;
          transport.sending = false;
        },
      };
      transports.push(transport);
      return transport;
    },
  });
  return {
    controller,
    createOperationId,
    validateOwner,
    expiries,
    initialNow,
    setNow: (value: number) => {
      now = value;
    },
    owner,
    other,
    entered,
    gate,
    operations,
    transports,
    startProvider,
    stopProvider,
    releaseOwner,
    loseOwner: (reason: string) => ownerLost(reason),
  };
}

function whenOff(controller: RealtimeVoiceController): Promise<void> {
  if (controller.getSnapshot().mode === "off") return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().mode === "off") {
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("app-owned realtime voice", () => {
  it("creates a frozen operation before permission and sends matching ownership on stop", async () => {
    const f = fixture("microphone");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    expect(f.createOperationId).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().owner).toMatchObject({
      ...f.owner,
      operationId: "operation-1",
    });
    expect(Object.isFrozen(f.controller.getSnapshot().owner)).toBe(true);
    f.gate.resolve();
    await pending;
    const off = whenOff(f.controller);
    f.controller.end();
    await off;
    expect(f.stopProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...f.owner, operationId: "operation-1" }),
      expect.objectContaining({
        operationId: "operation-1",
        voiceSessionToken: "token-operation-1",
        providerSessionId: f.owner.providerSessionId,
        providerThreadId: f.owner.providerThreadId,
      }),
    );
    expect(Object.isFrozen(f.stopProvider.mock.calls[0]?.[1])).toBe(true);
  });

  it("moves explicitly only after the original matching stop confirms closure", async () => {
    const f = fixture();
    const closed = deferred();
    f.stopProvider.mockImplementationOnce(async () => {
      f.operations.push("stop");
      await closed.promise;
    });
    await f.controller.start(f.owner);
    const moving = f.controller.move(f.other);
    expect(f.transports[0]?.closed).toBe(true);
    expect(f.transports).toHaveLength(1);
    expect(f.createOperationId).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().mode).toBe("ending");
    closed.resolve();
    await moving;
    expect(f.transports).toHaveLength(2);
    expect(f.operations.indexOf("close")).toBeLessThan(f.operations.indexOf("stop"));
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "transmitting",
      owner: { ...f.other, operationId: "operation-2" },
    });
    expect(f.startProvider.mock.calls[0]?.[0].environmentId).toBe(f.owner.environmentId);
    expect(f.startProvider.mock.calls[1]?.[0].environmentId).toBe(f.other.environmentId);
    f.transports[0]!.events.failed("late A failure");
    f.transports[0]!.events.connected();
    expect(f.transports[1]?.closed).toBe(false);
    expect(f.stopProvider).toHaveBeenCalledOnce();
  });

  it("validates a move destination before ending the current conversation", async () => {
    const f = fixture();
    await f.controller.start(f.owner);
    f.validateOwner.mockImplementation((owner) => {
      if (owner.environmentId === f.other.environmentId)
        throw new Error("Destination permission denied");
    });
    await expect(f.controller.move(f.other)).rejects.toThrow("Destination permission denied");
    expect(f.transports[0]?.closed).toBe(false);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", owner: f.owner });
    expect(f.stopProvider).not.toHaveBeenCalled();
  });

  it("revalidates destination permissions after closure before acquiring its microphone", async () => {
    const f = fixture();
    const closed = deferred();
    f.stopProvider.mockImplementationOnce(async () => {
      await closed.promise;
    });
    await f.controller.start(f.owner);
    const moving = f.controller.move(f.other);
    f.validateOwner.mockImplementation(() => {
      throw new Error("Destination was revoked");
    });
    closed.resolve();
    await expect(moving).rejects.toThrow("Destination was revoked");
    expect(f.transports).toHaveLength(1);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "off", replacementBlocked: false });
  });

  it("does not move or restart after a native-close timeout", async () => {
    const f = fixture();
    f.stopProvider.mockRejectedValue(
      new Error("Native closure timed out; reservation quarantined"),
    );
    await f.controller.start(f.owner);
    await f.controller.move(f.other);
    await f.controller.start(f.owner);
    expect(f.startProvider).toHaveBeenCalledOnce();
    expect(f.transports).toHaveLength(1);
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "off",
      replacementBlocked: true,
      reason: expect.stringContaining("quarantined"),
    });
  });

  it("lets End cancel a pending move without starting its destination later", async () => {
    const f = fixture("microphone");
    const starting = f.controller.start(f.owner);
    await f.entered.promise;
    const moving = f.controller.move(f.other);
    f.controller.end();
    f.gate.resolve();
    await starting;
    await moving;
    expect(f.transports).toHaveLength(1);
    expect(f.startProvider).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().mode).toBe("off");
  });

  it("does not carry a queued move across owner or account loss during cleanup", async () => {
    const f = fixture();
    const closed = deferred();
    f.stopProvider.mockImplementationOnce(async () => {
      await closed.promise;
    });
    await f.controller.start(f.owner);
    const moving = f.controller.move(f.other);
    f.loseOwner("Signed-in account changed");
    closed.resolve();
    await moving;
    expect(f.startProvider).toHaveBeenCalledOnce();
    expect(f.transports).toHaveLength(1);
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "off",
      reason: "Signed-in account changed",
    });
  });

  it.each(["legacy", "operation", "token", "provider", "expiry"] as const)(
    "fails closed on a %s ownership response",
    async (kind) => {
      const f = fixture();
      const result = {
        sdp: "answer",
        operationId: "operation-1",
        voiceSessionToken: "original-token",
        providerInstanceId: f.owner.providerInstanceId,
        providerThreadId: f.owner.providerThreadId,
        providerSessionId: f.owner.providerSessionId,
        expiresAt: "2026-10-24T00:00:00.000Z",
      };
      const returnedProvider = {
        providerInstanceId: ProviderInstanceId.make("replacement-codex"),
        providerThreadId: ProviderThreadId.make("replacement-thread"),
        providerSessionId: ProviderSessionId.make("replacement-session"),
      };
      f.startProvider.mockResolvedValueOnce(
        kind === "legacy"
          ? { sdp: "answer" }
          : {
              ...result,
              ...(kind === "operation" ? { operationId: "old-operation" } : {}),
              ...(kind === "token" ? { voiceSessionToken: "" } : {}),
              ...(kind === "provider" ? returnedProvider : {}),
              ...(kind === "expiry" ? { expiresAt: "not-a-time" } : {}),
            },
      );
      await f.controller.start(f.owner);
      await whenOff(f.controller);
      expect(f.operations).not.toContain("remote");
      expect(f.transports[0]?.sending).toBe(false);
      expect(f.transports[0]?.closed).toBe(true);
      if (kind === "provider") {
        expect(f.stopProvider).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ ...f.owner, operationId: "operation-1" }),
          {
            ...returnedProvider,
            operationId: result.operationId,
            voiceSessionToken: result.voiceSessionToken,
            expiresAt: result.expiresAt,
          },
        );
        expect(f.controller.getSnapshot()).toMatchObject({
          mode: "off",
          replacementBlocked: false,
          reason: expect.stringContaining("provider changed"),
        });
        expect(f.controller.getSnapshot().reason).not.toContain("Update the T3 host");
        return;
      }
      expect(f.stopProvider).not.toHaveBeenCalled();
      expect(f.controller.getSnapshot()).toMatchObject({
        mode: "off",
        replacementBlocked: true,
        reason: expect.stringContaining("Update the T3 host"),
      });
      await f.controller.start(f.other);
      expect(f.transports).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "cleans up a drifted binding after owner loss and retains its reason (cleanup fails=%s)",
    async (cleanupFails) => {
      const f = fixture();
      const result = {
        sdp: "answer",
        operationId: "operation-1",
        voiceSessionToken: "drift-token",
        providerInstanceId: ProviderInstanceId.make("replacement-codex"),
        providerThreadId: ProviderThreadId.make("replacement-thread"),
        providerSessionId: ProviderSessionId.make("replacement-session"),
        expiresAt: "2026-10-24T00:00:00.000Z",
      };
      f.startProvider.mockImplementationOnce(async () => {
        f.entered.resolve();
        await f.gate.promise;
        return result;
      });
      if (cleanupFails) f.stopProvider.mockRejectedValue(new Error("Native closure unconfirmed"));
      const pending = f.controller.start(f.owner);
      await f.entered.promise;
      const ownerLossReason = "The conversation's provider changed while starting voice.";
      f.loseOwner(ownerLossReason);
      f.gate.resolve();
      await pending;
      await whenOff(f.controller);
      expect(f.stopProvider).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ ...f.owner, operationId: "operation-1" }),
        {
          operationId: result.operationId,
          voiceSessionToken: result.voiceSessionToken,
          providerInstanceId: result.providerInstanceId,
          providerThreadId: result.providerThreadId,
          providerSessionId: result.providerSessionId,
          expiresAt: result.expiresAt,
        },
      );
      expect(f.operations).not.toContain("remote");
      expect(f.transports[0]?.sending).toBe(false);
      expect(f.transports[0]?.closed).toBe(true);
      expect(f.controller.getSnapshot()).toMatchObject({
        mode: "off",
        replacementBlocked: cleanupFails,
        reason: expect.stringContaining(ownerLossReason),
      });
      expect(f.controller.getSnapshot().reason).not.toContain("Update the T3 host");
      if (cleanupFails) {
        await f.controller.start(f.other);
        expect(f.transports).toHaveLength(1);
      }
    },
  );

  it("stops at the bounded lifetime and ignores expiry callbacks after a new explicit start", async () => {
    const f = fixture();
    await f.controller.start(f.owner);
    const expiry = f.expiries[0]!;
    expect(expiry.at).toBe(f.initialNow + 4 * 60 * 60 * 1000);
    f.setNow(expiry.at);
    const off = whenOff(f.controller);
    expiry.expire();
    expect(f.transports[0]?.closed).toBe(true);
    await off;
    expect(f.startProvider).toHaveBeenCalledOnce();
    expect(expiry.cancel).toHaveBeenCalledOnce();
    await f.controller.start(f.owner);
    expiry.expire();
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "transmitting",
      owner: { operationId: "operation-2" },
    });
    expect(f.transports[1]?.closed).toBe(false);
  });

  it("does not enable input when negotiation finishes after the deadline", async () => {
    const f = fixture("remote");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    f.setNow(f.expiries[0]!.at);
    f.gate.resolve();
    await pending;
    await whenOff(f.controller);
    expect(f.transports[0]?.sending).toBe(false);
    expect(f.transports[0]?.closed).toBe(true);
    expect(f.stopProvider).toHaveBeenCalledOnce();
  });

  it("cleans up an already expired owned response without enabling input", async () => {
    const f = fixture();
    f.startProvider.mockResolvedValueOnce({
      sdp: "answer",
      operationId: "operation-1",
      voiceSessionToken: "expired-token",
      providerInstanceId: f.owner.providerInstanceId,
      providerThreadId: f.owner.providerThreadId,
      providerSessionId: f.owner.providerSessionId,
      expiresAt: "2026-10-23T19:59:00.000Z",
    });
    await f.controller.start(f.owner);
    await whenOff(f.controller);
    expect(f.transports[0]?.sending).toBe(false);
    expect(f.operations).not.toContain("remote");
    expect(f.stopProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operationId: "operation-1" }),
      expect.objectContaining({ voiceSessionToken: "expired-token" }),
    );
    expect(f.controller.getSnapshot().replacementBlocked).toBe(false);
  });

  it("never schedules capture beyond four hours even if a host advertises a later deadline", async () => {
    const f = fixture();
    f.startProvider.mockResolvedValueOnce({
      sdp: "answer",
      operationId: "operation-1",
      voiceSessionToken: "bounded-token",
      providerInstanceId: f.owner.providerInstanceId,
      providerThreadId: f.owner.providerThreadId,
      providerSessionId: f.owner.providerSessionId,
      expiresAt: "2026-10-24T04:00:00.000Z",
    });
    await f.controller.start(f.owner);
    expect(f.expiries[0]?.at).toBe(f.initialNow + 4 * 60 * 60 * 1000);
    expect(f.controller.getSnapshot().expiresAt).toBe("2026-10-24T00:00:00.000Z");
  });

  it("allows an explicit same-conversation restart after provider cleanup succeeds", async () => {
    const f = fixture();
    await f.controller.start(f.owner);
    const off = whenOff(f.controller);
    f.controller.end();
    await off;
    expect(f.controller.getSnapshot().replacementBlocked).toBe(false);
    await f.controller.start(f.owner);
    expect(f.startProvider).toHaveBeenCalledTimes(2);
    expect(f.transports).toHaveLength(2);
  });

  it("retains the owner detail subscription until cancelled provider startup is cleaned up", async () => {
    const f = fixture("provider", true);
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    f.controller.end();
    expect(f.releaseOwner).not.toHaveBeenCalled();
    const off = whenOff(f.controller);
    f.gate.resolve();
    await pending;
    await off;
    expect(f.stopProvider).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "off", reason: null });
    expect(f.releaseOwner).toHaveBeenCalledOnce();
  });

  it.each<Stage>(["offer", "local", "ice"])(
    "finishes local cancellation even when %s never settles",
    async (stage) => {
      const f = fixture(stage);
      void f.controller.start(f.owner);
      await f.entered.promise;
      f.controller.end();
      expect(f.transports[0]?.closed).toBe(true);
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "off", replacementBlocked: false });
      expect(f.releaseOwner).toHaveBeenCalledOnce();
      await f.controller.start(f.other);
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", owner: f.other });
    },
  );

  it("keeps deliberate cancellation when a later microphone denial arrives", async () => {
    const f = fixture("microphone");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    f.controller.end();
    f.gate.reject(new Error("late permission denial"));
    await pending;
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "off", reason: null });
    expect(f.releaseOwner).toHaveBeenCalledOnce();
  });

  it("ignores a cancelled negotiation rejecting after its replacement is transmitting", async () => {
    const f = fixture("offer");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    f.controller.end();
    await f.controller.start(f.other);
    f.gate.reject(new Error("old closed peer"));
    await pending;
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", owner: f.other });
    expect(f.transports[1]?.closed).toBe(false);
    expect(f.releaseOwner).toHaveBeenCalledOnce();
  });

  it("captures the immutable environment/thread before permission and rejects a second owner", async () => {
    const f = fixture("microphone");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "connecting", owner: f.owner });
    await f.controller.start(f.other);
    expect(f.transports).toHaveLength(1);
    f.gate.resolve();
    await pending;
    expect(f.startProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...f.owner, operationId: "operation-1" }),
      "offer",
    );
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", owner: f.owner });
    expect(Object.isFrozen(f.controller.getSnapshot().owner)).toBe(true);
  });

  it.each<Stage>(["microphone", "offer", "local", "ice", "provider", "remote"])(
    "cancels at %s without allowing the continuation to send",
    async (stage) => {
      const f = fixture(stage);
      const pending = f.controller.start(f.owner);
      await f.entered.promise;
      f.controller.end();
      expect(f.transports[0]?.closed).toBe(true);
      expect(f.transports[0]?.sending).toBe(false);
      const off = whenOff(f.controller);
      f.gate.resolve();
      await pending;
      await off;
      expect(f.controller.getSnapshot().mode).toBe("off");
      expect(f.transports[0]?.sending).toBe(false);
      if (stage === "provider" || stage === "remote") {
        expect(f.stopProvider).toHaveBeenCalledOnce();
        expect(f.operations.indexOf("close")).toBeLessThan(f.operations.indexOf("stop"));
        await f.controller.start(f.other);
        expect(f.transports).toHaveLength(2);
        expect(f.controller.getSnapshot().replacementBlocked).toBe(false);
      } else {
        expect(f.startProvider).not.toHaveBeenCalled();
        expect(f.stopProvider).not.toHaveBeenCalled();
      }
    },
  );

  it("does not mark transmitting until both negotiation and transport readiness", async () => {
    const f = fixture("remote");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    const transport = f.transports[0]!;
    transport.ready = false;
    transport.events.connected();
    expect(transport.sending).toBe(false);
    f.gate.resolve();
    await pending;
    expect(f.controller.getSnapshot().mode).toBe("connecting");
    transport.ready = true;
    transport.events.connected();
    expect(f.controller.getSnapshot().mode).toBe("transmitting");
    expect(transport.sending).toBe(true);
  });

  it("keeps the capture reservation until a cancelled permission request settles", async () => {
    const f = fixture("microphone");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    f.controller.end();
    await f.controller.start(f.other);
    expect(f.controller.getSnapshot().mode).toBe("ending");
    expect(f.transports).toHaveLength(1);
    f.gate.resolve();
    await pending;
    expect(f.controller.getSnapshot().mode).toBe("off");
    await f.controller.start(f.other);
    expect(f.transports).toHaveLength(2);
  });

  it("ignores an old permission failure and old transport callbacks after a new owner starts", async () => {
    const f = fixture("microphone");
    const old = f.controller.start(f.owner);
    await f.entered.promise;
    f.controller.end();
    f.gate.reject(new Error("old permission denied"));
    await old;
    await f.controller.start(f.other);
    f.transports[0]!.events.failed("old peer failed");
    f.transports[0]!.events.connected();
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", owner: f.other });
    expect(f.transports[1]?.closed).toBe(false);
    expect(f.stopProvider).not.toHaveBeenCalled();
  });

  it("closes locally on owner loss and never reconnects on a late ready event", async () => {
    const f = fixture();
    await f.controller.start(f.owner);
    const off = whenOff(f.controller);
    f.loseOwner("Owner permission revoked");
    expect(f.transports[0]?.closed).toBe(true);
    await off;
    f.transports[0]!.events.connected();
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "off",
      reason: "Owner permission revoked",
    });
    expect(f.startProvider).toHaveBeenCalledOnce();
    expect(f.stopProvider).toHaveBeenCalledOnce();
  });

  it("uses matching ownership for late cleanup after owner loss during provider startup", async () => {
    const f = fixture("provider");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    f.loseOwner("Provider replaced");
    const off = whenOff(f.controller);
    f.gate.resolve();
    await pending;
    await off;
    expect(f.stopProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ...f.owner, operationId: "operation-1" }),
      expect.objectContaining({
        operationId: "operation-1",
        voiceSessionToken: "token-operation-1",
        providerSessionId: f.owner.providerSessionId,
        providerThreadId: f.owner.providerThreadId,
      }),
    );
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "off",
      reason: "Provider replaced",
      replacementBlocked: false,
    });
  });

  it("does not stop an unowned provider session after a rejected start", async () => {
    const f = fixture("provider");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    f.gate.reject(new Error("another client owns voice"));
    await pending;
    expect(f.transports[0]?.closed).toBe(true);
    expect(f.stopProvider).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "off", replacementBlocked: true });
    expect(f.releaseOwner).toHaveBeenCalledOnce();
  });

  it("retains the replacement gate after failed stop and sends stop only once", async () => {
    const f = fixture();
    f.stopProvider.mockRejectedValue(new Error("host unavailable"));
    await f.controller.start(f.owner);
    const off = whenOff(f.controller);
    f.controller.end();
    f.controller.end();
    await off;
    await f.controller.start(f.other);
    expect(f.stopProvider).toHaveBeenCalledOnce();
    expect(f.transports).toHaveLength(1);
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "off",
      replacementBlocked: true,
      reason: expect.stringContaining("host unavailable"),
    });
    expect(f.releaseOwner).toHaveBeenCalledOnce();
  });
});
