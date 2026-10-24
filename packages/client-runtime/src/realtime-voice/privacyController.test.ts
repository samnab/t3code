import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRealtimeVoiceController,
  type RealtimeVoiceController,
  type VoiceOwner,
  type VoiceTransport,
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
  const stopProvider = vi.fn(async () => {
    if (requireMountedOwner && !ownerMounted) throw new Error("Owner detail was dropped");
    operations.push("stop");
  });
  const startProvider = vi.fn(async () => {
    await step("provider", 0);
    return "answer";
  });
  const controller = createRealtimeVoiceController({
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
    expect(f.startProvider).toHaveBeenCalledExactlyOnceWith(f.owner, "offer");
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
        expect(f.transports).toHaveLength(1);
        expect(f.controller.getSnapshot().replacementBlocked).toBe(true);
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
    expect(f.stopProvider).not.toHaveBeenCalled();
  });

  it("does not send a late thread-only stop after owner loss during provider startup", async () => {
    const f = fixture("provider");
    const pending = f.controller.start(f.owner);
    await f.entered.promise;
    f.loseOwner("Provider replaced");
    const off = whenOff(f.controller);
    f.gate.resolve();
    await pending;
    await off;
    expect(f.stopProvider).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot()).toMatchObject({
      mode: "off",
      reason: "Provider replaced",
      replacementBlocked: true,
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
