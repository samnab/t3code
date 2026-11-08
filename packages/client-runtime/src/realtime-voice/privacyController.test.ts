import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderRealtimeVoiceError,
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

function fixture(holdAt?: Stage, requireMountedOwner = false, keywordsEnabled = false) {
  const entered = deferred();
  const gate = deferred();
  const operations: string[] = [];
  const transports: Array<
    VoiceTransport & {
      readonly events: { connected(): void; failed(reason: string): void };
      closed: boolean;
      sending: boolean;
      muted: boolean;
      ready: boolean;
      sent: string[];
      capture(frame: string): void;
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
  const localListening = {
    failStart: false,
    start: vi.fn(() => {
      operations.push("listen");
      if (localListening.failStart) throw new Error("worklet failed");
    }),
    stop: vi.fn(() => {
      operations.push("unlisten");
    }),
  };
  const controller = createRealtimeVoiceController({
    keywordsEnabled,
    localListening,
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
        muted: false,
        ready: true,
        sent: [] as string[],
        capture: (frame: string) => {
          if (transport.sending && !transport.muted) transport.sent.push(frame);
        },
        levels: () => ({ input: 0.3, output: 0.2 }),
        setMicMuted: (muted: boolean) => {
          operations.push(muted ? "mute" : "unmute");
          transport.muted = muted;
        },
        setKeywords: (on: boolean) => {
          operations.push(on ? "tap" : "untap");
        },
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
    localListening,
    createOperationId,
    validateOwner,
    expiries,
    initialNow,
    setNow: (value: number) => {
      now = value;
    },
    // Detector audio time; tests keep it equal to elapsed wall time unless a backlog is modelled.
    audioNow: () => now - initialNow,
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

function whenMode(
  controller: RealtimeVoiceController,
  mode: ReturnType<RealtimeVoiceController["getSnapshot"]>["mode"],
): Promise<void> {
  if (controller.getSnapshot().mode === mode) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().mode === mode) {
        unsubscribe();
        resolve();
      }
    });
  });
}

const whenOff = (controller: RealtimeVoiceController) => whenMode(controller, "off");

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

  it("allows a new call after the host refuses a start before reaching the provider", async () => {
    const f = fixture();
    f.startProvider.mockRejectedValueOnce(
      new ProviderRealtimeVoiceError({
        threadId: f.owner.threadId,
        cause: "Send a message first.",
        refusedBeforeStart: true,
      }),
    );
    await f.controller.start(f.owner);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "off", replacementBlocked: false });
    expect(f.controller.getSnapshot().reason).not.toContain("New calls remain blocked");
    await f.controller.start(f.owner);
    expect(f.transports).toHaveLength(2);
    expect(f.controller.getSnapshot().mode).toBe("transmitting");
    expect(f.stopProvider).not.toHaveBeenCalled();
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

describe("local privacy pause", () => {
  it("revokes locally before the provider stop and resumes on a fresh peer and operation", async () => {
    const f = fixture();
    const closed = deferred();
    f.stopProvider.mockImplementationOnce(async () => {
      f.operations.push("stop");
      await closed.promise;
    });
    await f.controller.start(f.owner);
    const first = f.transports[0]!;
    first.capture("A");
    f.controller.pause("Paused by test");
    // Nothing awaited: the gate is shut while the provider stop is still in flight.
    expect(first.closed).toBe(true);
    expect(first.sending).toBe(false);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "pausing", owner: f.owner });
    first.capture("B");
    first.events.connected();
    first.capture("B2");
    expect(first.sent).toEqual(["A"]);
    expect(f.operations.indexOf("close")).toBeLessThan(f.operations.indexOf("stop"));
    closed.resolve();
    await whenMode(f.controller, "paused");
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "paused",
      owner: { ...f.owner, operationId: "operation-1" },
      reason: "Paused by test",
      replacementBlocked: false,
    });
    expect(f.releaseOwner).toHaveBeenCalledOnce();
    await f.controller.resume(f.owner);
    const second = f.transports[1]!;
    second.capture("C");
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "transmitting",
      owner: { ...f.owner, operationId: "operation-2" },
    });
    expect(second).not.toBe(first);
    expect(first.sent).toEqual(["A"]);
    expect(second.sent).toEqual(["C"]);
    expect(f.stopProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operationId: "operation-1" }),
      expect.objectContaining({ voiceSessionToken: "token-operation-1" }),
    );
    expect(f.startProvider.mock.calls.map(([owner]) => owner.operationId)).toEqual([
      "operation-1",
      "operation-2",
    ]);
  });

  it.each<Stage>(["microphone", "offer", "local", "ice", "provider", "remote"])(
    "ends paused when pause races startup at %s",
    async (stage) => {
      const f = fixture(stage);
      const pending = f.controller.start(f.owner);
      await f.entered.promise;
      f.controller.pause();
      expect(f.transports[0]?.closed).toBe(true);
      const paused = whenMode(f.controller, "paused");
      f.gate.resolve();
      await pending;
      await paused;
      f.transports[0]!.events.connected();
      f.transports[0]!.capture("late");
      expect(f.transports[0]?.sent).toEqual([]);
      expect(f.controller.getSnapshot()).toMatchObject({
        mode: "paused",
        owner: f.owner,
        replacementBlocked: false,
      });
      expect(f.stopProvider).toHaveBeenCalledTimes(
        stage === "provider" || stage === "remote" ? 1 : 0,
      );
      await f.controller.resume(f.owner);
      expect(f.transports).toHaveLength(2);
      expect(f.controller.getSnapshot().mode).toBe("transmitting");
    },
  );

  it("stays denied when pause cleanup or a resume check fails", async () => {
    const f = fixture();
    await f.controller.start(f.owner);
    f.validateOwner.mockImplementationOnce(() => {
      throw new Error("Conversation unavailable");
    });
    f.controller.pause();
    await whenMode(f.controller, "paused");
    await expect(f.controller.resume(f.owner)).rejects.toThrow("Conversation unavailable");
    expect(f.transports).toHaveLength(1);
    expect(f.controller.getSnapshot().mode).toBe("paused");
    await f.controller.resume(f.other);
    expect(f.transports).toHaveLength(1);

    const g = fixture();
    g.stopProvider.mockRejectedValue(new Error("Native closure unconfirmed"));
    await g.controller.start(g.owner);
    g.controller.pause();
    await whenMode(g.controller, "paused");
    expect(g.controller.getSnapshot()).toMatchObject({
      mode: "paused",
      replacementBlocked: true,
      reason: expect.stringContaining("Native closure unconfirmed"),
    });
    await g.controller.resume(g.owner);
    await g.controller.start(g.owner);
    expect(g.transports).toHaveLength(1);
    g.controller.end();
    expect(g.controller.getSnapshot()).toMatchObject({ mode: "off", replacementBlocked: true });
  });

  it("lets Stop session override a pending pause and forget a paused conversation", async () => {
    const f = fixture();
    const closed = deferred();
    f.stopProvider.mockImplementationOnce(async () => {
      await closed.promise;
    });
    await f.controller.start(f.owner);
    f.controller.pause();
    f.controller.end();
    expect(f.controller.getSnapshot().mode).toBe("ending");
    closed.resolve();
    await whenOff(f.controller);
    await f.controller.resume(f.owner);
    expect(f.transports).toHaveLength(1);

    await f.controller.start(f.owner);
    f.controller.pause();
    await whenMode(f.controller, "paused");
    f.controller.end();
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "off", owner: null, reason: null });
    await f.controller.resume(f.owner);
    expect(f.transports).toHaveLength(2);
  });

  describe("local keywords", () => {
    const pausedWithKeywords = async () => {
      const f = fixture(undefined, false, true);
      await f.controller.start(f.owner);
      f.controller.pause();
      await whenMode(f.controller, "paused");
      return f;
    };

    it("toggles a live call's keyword tap at once without touching mute, sending or local listening", async () => {
      const f = fixture();
      await f.controller.start(f.owner);
      f.controller.setMicMuted(true);
      f.operations.length = 0;
      f.controller.setKeywords(true);
      expect(f.operations).toEqual(["tap"]);
      expect(f.controller.getSnapshot()).toMatchObject({
        mode: "transmitting",
        keywords: true,
        micMuted: true,
        listening: "off",
      });
      f.controller.setKeywords(false);
      expect(f.operations).toEqual(["tap", "untap"]);
      expect(f.transports[0]).toMatchObject({ sending: true, muted: true, closed: false });
      expect(f.localListening.start).not.toHaveBeenCalled();
      f.controller.setKeywords(true);
      f.controller.pause();
      await whenMode(f.controller, "paused");
      expect(f.controller.getSnapshot()).toMatchObject({ keywords: true, listening: "listening" });
      expect(f.operations.indexOf("close")).toBeLessThan(f.operations.indexOf("listen"));
    });

    it("listens only after the call's capture closed and stops before resume opens a new one", async () => {
      const f = await pausedWithKeywords();
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "listening" });
      expect(f.operations.indexOf("close")).toBeLessThan(f.operations.indexOf("listen"));
      await f.controller.resume(f.owner);
      expect(f.operations.lastIndexOf("unlisten")).toBeLessThan(
        f.operations.lastIndexOf("microphone"),
      );
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", listening: "off" });
    });

    it("stops local listening before a move or start from pause acquires a new microphone", async () => {
      for (const leave of ["move", "start"] as const) {
        const f = await pausedWithKeywords();
        f.operations.length = 0;
        if (leave === "move") await f.controller.move(f.other);
        else await f.controller.start(f.owner);
        expect(f.localListening.stop).toHaveBeenCalledOnce();
        expect(f.operations.indexOf("unlisten")).toBeGreaterThanOrEqual(0);
        expect(f.operations.indexOf("unlisten")).toBeLessThan(f.operations.indexOf("microphone"));
        f.controller.end();
        expect(f.localListening.stop).toHaveBeenCalledOnce();
      }
    });

    it("keeps listening honestly when a resume never starts a call", async () => {
      const f = await pausedWithKeywords();
      f.validateOwner.mockImplementation(() => {
        throw new Error("grant revoked");
      });
      await expect(f.controller.resume(f.owner)).rejects.toThrow("grant revoked");
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "listening" });
      expect(f.localListening.start).toHaveBeenCalledTimes(2);
      expect(f.localListening.stop).toHaveBeenCalledOnce();
    });

    it("the resume phrase alone never opens sending", async () => {
      const f = await pausedWithKeywords();
      f.setNow(f.initialNow + 5_000);
      f.controller.armResume(f.audioNow());
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "armed" });
      expect(f.transports).toHaveLength(1);
      expect(f.startProvider).toHaveBeenCalledOnce();
    });

    // Arms at now = initialNow + 5 s, after the echo tail.
    const armed = async () => {
      const f = await pausedWithKeywords();
      f.setNow(f.initialNow + 5_000);
      f.controller.armResume(f.audioNow());
      expect(f.controller.getSnapshot().listening).toBe("armed");
      return f;
    };

    it("resumes on a fresh call from a spoken confirm after the gap, listening stopped first", async () => {
      const f = await armed();
      f.setNow(f.initialNow + 8_000);
      f.operations.length = 0;
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      expect(f.operations.indexOf("unlisten")).toBe(0);
      expect(f.operations.indexOf("unlisten")).toBeLessThan(f.operations.indexOf("microphone"));
      expect(f.controller.getSnapshot()).toMatchObject({
        mode: "transmitting",
        listening: "off",
        owner: { ...f.owner, operationId: "operation-2" },
      });
      expect(f.transports).toHaveLength(2);
      expect(f.expiries.find((e) => e.at === f.initialNow + 15_000)?.cancel).toHaveBeenCalled();
    });

    it("ignores a confirm before any arm and queues nothing for a later arm", async () => {
      const f = await pausedWithKeywords();
      f.setNow(f.initialNow + 5_000);
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      f.controller.armResume(f.audioNow());
      f.setNow(f.initialNow + 8_000);
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "armed" });
      expect(f.startProvider).toHaveBeenCalledOnce();
    });

    it("ignores a confirm inside the gap and stays armed for a later one", async () => {
      const f = await armed();
      f.setNow(f.initialNow + 7_999);
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "armed" });
      expect(f.startProvider).toHaveBeenCalledOnce();
      f.setNow(f.initialNow + 8_000);
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      expect(f.controller.getSnapshot().mode).toBe("transmitting");
    });

    it("measures the gap in detector audio, so a backlog cannot stretch one utterance past it", async () => {
      const f = await armed();
      // One breath: confirm ends 1.92 s of audio after the arm but arrives 4 s later in wall time.
      f.setNow(f.initialNow + 9_000);
      await f.controller.spokenConfirm(f.owner, 5_000 + 1_920);
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "armed" });
      expect(f.startProvider).toHaveBeenCalledOnce();
      await f.controller.spokenConfirm(f.owner, 5_000 + 3_000);
      expect(f.controller.getSnapshot().mode).toBe("transmitting");
    });

    it("ignores a confirm after the window expired", async () => {
      const f = await armed();
      f.setNow(f.initialNow + 15_000);
      f.expiries.at(-1)!.expire();
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "listening" });
      expect(f.startProvider).toHaveBeenCalledOnce();
    });

    it("does not extend the deadline on a second resume phrase", async () => {
      const f = await armed();
      const scheduled = f.expiries.length;
      f.setNow(f.initialNow + 9_000);
      f.controller.armResume(f.audioNow());
      expect(f.expiries).toHaveLength(scheduled);
      // Past the first deadline, even before its timer fires.
      f.setNow(f.initialNow + 15_001);
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      expect(f.startProvider).toHaveBeenCalledOnce();
    });

    it("starts once for two confirms, and a refused start needs a new arm", async () => {
      const f = await armed();
      f.setNow(f.initialNow + 8_000);
      await Promise.all([
        f.controller.spokenConfirm(f.owner, f.audioNow()),
        f.controller.spokenConfirm(f.owner, f.audioNow()),
      ]);
      expect(f.startProvider).toHaveBeenCalledTimes(2);

      const g = await armed();
      g.setNow(g.initialNow + 8_000);
      g.validateOwner.mockImplementationOnce(() => {
        throw new Error("grant revoked");
      });
      await expect(g.controller.spokenConfirm(g.owner, g.audioNow())).rejects.toThrow(
        "grant revoked",
      );
      expect(g.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "listening" });
      await g.controller.spokenConfirm(g.owner, g.audioNow());
      expect(g.startProvider).toHaveBeenCalledOnce();
    });

    it("disarms on the pause phrase while armed", async () => {
      const f = await armed();
      f.controller.pause();
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "listening" });
      expect(f.expiries.at(-1)!.cancel).toHaveBeenCalled();
      f.setNow(f.initialNow + 8_000);
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      expect(f.startProvider).toHaveBeenCalledOnce();
    });

    it("does nothing on a confirm outside pause", async () => {
      const f = fixture(undefined, false, true);
      await f.controller.start(f.owner);
      f.setNow(f.initialNow + 8_000);
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", listening: "off" });
      expect(f.transports).toHaveLength(1);
      expect(f.startProvider).toHaveBeenCalledOnce();
    });

    it("keeps the microphone muted through a spoken resume", async () => {
      const f = await pausedWithKeywords();
      f.controller.end();
      await f.controller.start(f.owner);
      f.controller.setMicMuted(true);
      f.controller.pause();
      await whenMode(f.controller, "paused");
      f.setNow(f.initialNow + 5_000);
      f.controller.armResume(f.audioNow());
      f.setNow(f.initialNow + 8_000);
      await f.controller.spokenConfirm(f.owner, f.audioNow());
      const call = f.transports.at(-1)!;
      call.capture("B");
      expect(call.sent).toEqual([]);
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", micMuted: true });
    });

    it("ignores the resume phrase during the echo tail after the call closed", async () => {
      const f = await pausedWithKeywords();
      f.controller.armResume(f.audioNow());
      expect(f.controller.getSnapshot().listening).toBe("listening");
    });

    it("disarms when the confirm window expires", async () => {
      const f = await pausedWithKeywords();
      f.setNow(f.initialNow + 5_000);
      f.controller.armResume(f.audioNow());
      const arm = f.expiries.at(-1)!;
      expect(arm.at).toBe(f.initialNow + 15_000);
      arm.expire();
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "listening" });
    });

    it("ignores a second resume phrase as a confirm", async () => {
      const f = await pausedWithKeywords();
      f.setNow(f.initialNow + 5_000);
      f.controller.armResume(f.audioNow());
      f.controller.armResume(f.audioNow());
      expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", listening: "armed" });
      expect(f.transports).toHaveLength(1);
    });

    it("denies on detector failure, paused or live, and never resumes", async () => {
      const f = await pausedWithKeywords();
      f.controller.localListeningFailed();
      expect(f.controller.getSnapshot()).toMatchObject({
        mode: "paused",
        listening: "unavailable",
      });
      expect(f.localListening.stop).toHaveBeenCalledOnce();
      f.controller.armResume(f.audioNow());
      expect(f.controller.getSnapshot().listening).toBe("unavailable");

      const g = fixture(undefined, false, true);
      await g.controller.start(g.owner);
      g.controller.localListeningFailed();
      expect(g.transports[0]?.sending).toBe(false);
      await whenMode(g.controller, "paused");
      expect(g.controller.getSnapshot()).toMatchObject({ listening: "unavailable" });
      expect(g.localListening.start).not.toHaveBeenCalled();

      const h = fixture(undefined, false, true);
      h.localListening.failStart = true;
      await h.controller.start(h.owner);
      h.controller.pause();
      await whenMode(h.controller, "paused");
      expect(h.controller.getSnapshot().listening).toBe("unavailable");
    });

    it("stays exactly as before when keywords are off, and Stop session releases local listening", async () => {
      const f = fixture();
      await f.controller.start(f.owner);
      f.controller.pause();
      await whenMode(f.controller, "paused");
      expect(f.controller.getSnapshot()).toMatchObject({ keywords: false, listening: "off" });
      expect(f.localListening.start).not.toHaveBeenCalled();

      const g = await pausedWithKeywords();
      g.controller.end();
      expect(g.controller.getSnapshot()).toMatchObject({ mode: "off", listening: "off" });
      expect(g.localListening.stop).toHaveBeenCalledOnce();
    });
  });
});

describe("microphone mute", () => {
  it("is refused while connecting or paused and survives pause, Resume and move", async () => {
    const f = fixture("remote");
    const starting = f.controller.start(f.owner);
    await f.entered.promise;
    f.controller.setMicMuted(true);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "connecting", micMuted: false });
    f.gate.resolve();
    await starting;
    const first = f.transports[0]!;
    first.capture("A");
    f.controller.setMicMuted(true);
    first.capture("B");
    expect(first.sent).toEqual(["A"]);
    expect(first.closed).toBe(false);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", micMuted: true });
    f.controller.pause();
    await whenMode(f.controller, "paused");
    expect(first.closed).toBe(true);
    f.controller.setMicMuted(false);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "paused", micMuted: true });
    await f.controller.resume(f.owner);
    const second = f.transports[1]!;
    expect(f.operations.lastIndexOf("mute")).toBeLessThan(f.operations.lastIndexOf("microphone"));
    second.capture("B2");
    expect(second.sent).toEqual([]);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", micMuted: true });
    await f.controller.move(f.other);
    const third = f.transports[2]!;
    third.capture("B3");
    expect(third.sent).toEqual([]);
    expect(f.controller.getSnapshot()).toMatchObject({ owner: f.other, micMuted: true });
    f.controller.setMicMuted(false);
    third.capture("C");
    expect(third.sent).toEqual(["C"]);
    expect(f.controller.getSnapshot().micMuted).toBe(false);
  });

  it("clears when the session stops, so the next call starts unmuted", async () => {
    const f = fixture();
    await f.controller.start(f.owner);
    f.controller.setMicMuted(true);
    f.controller.end();
    await whenOff(f.controller);
    expect(f.transports[0]!.closed).toBe(true);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "off", micMuted: false });
    await f.controller.start(f.owner);
    expect(f.transports[1]!.muted).toBe(false);
    expect(f.controller.getSnapshot()).toMatchObject({ mode: "transmitting", micMuted: false });
  });

  it("reports levels only from a transmitting call", async () => {
    const f = fixture("remote");
    const starting = f.controller.start(f.owner);
    await f.entered.promise;
    expect(f.controller.levels()).toEqual({ input: 0, output: 0 });
    f.gate.resolve();
    await starting;
    expect(f.controller.levels()).toEqual({ input: 0.3, output: 0.2 });
    f.controller.pause();
    expect(f.controller.levels()).toEqual({ input: 0, output: 0 });
    await whenMode(f.controller, "paused");
    expect(f.controller.levels()).toEqual({ input: 0, output: 0 });
  });
});
