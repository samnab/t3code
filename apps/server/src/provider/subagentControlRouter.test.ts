import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ORCHESTRATION_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  SubagentControlError,
  type SubagentControlPlaneStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { ProviderUnsupportedError } from "./Errors.ts";
import type { ProviderSubagentControlPlaneShape } from "./Services/ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./Services/ProviderAdapterRegistry.ts";
import {
  routeSubagentControlBindingResult,
  routeSubagentControlCancel,
  routeSubagentControlStatus,
  routeSubagentControlSteer,
  type SubagentControlAdapterLookup,
} from "./subagentControlRouter.ts";

const RUN_ID = RuntimeTaskId.make("pi:epoch:act-1:sa-1");

const DECLARED_CAPABILITIES = {
  normalizedEvents: true,
  stableActivations: true,
  ownerRouting: true,
  steering: true,
  cancellation: true,
  reloadRestore: true,
  scheduling: true,
  nativeChildProjection: true,
  deliveryAcknowledgements: true,
} as const;

interface RecordingPlane extends ProviderSubagentControlPlaneShape<never> {
  readonly events: string[];
}

interface PlaneOptions {
  /** Run ids this adapter's session does not track. */
  readonly unknownRuns?: ReadonlyArray<string>;
  /** Fail every control with this error. */
  readonly failWith?: SubagentControlError;
}

const makePlane = (managerId: string, options: PlaneOptions = {}): RecordingPlane => {
  const events: string[] = [];
  const control = (op: "steer" | "cancel", input: { managerId: string; runId: string }) =>
    Effect.gen(function* () {
      if (options.failWith !== undefined) return yield* options.failWith;
      if (input.managerId !== managerId) {
        return yield* new SubagentControlError({ reason: "manager-mismatch" });
      }
      if (options.unknownRuns?.includes(input.runId) === true) {
        return yield* new SubagentControlError({ reason: "unknown-run" });
      }
      events.push(`${op}:${input.managerId}:${input.runId}`);
      return { accepted: true } as const;
    });
  return {
    events,
    status: () =>
      Effect.succeed([
        {
          supported: true,
          managerId,
          protocolVersion: 1,
          capabilities: { ...DECLARED_CAPABILITIES },
          controls: { steer: { enabled: true }, cancel: { enabled: true } },
        } satisfies SubagentControlPlaneStatus,
      ]),
    steer: (input) => control("steer", input),
    cancel: (input) => control("cancel", input),
  };
};

const makeLookup = (
  instances: ReadonlyArray<{
    readonly id: string;
    readonly driver: ProviderDriverKind;
    readonly plane?: ProviderSubagentControlPlaneShape<never>;
  }>,
): SubagentControlAdapterLookup => {
  const byId = new Map(instances.map((instance) => [instance.id, instance]));
  return {
    listInstances: () =>
      Effect.succeed(instances.map((instance) => ProviderInstanceId.make(instance.id))),
    getByInstance: (instanceId) =>
      Effect.gen(function* () {
        const instance = byId.get(instanceId);
        if (instance === undefined) {
          return yield* new ProviderUnsupportedError({ provider: instanceId });
        }
        return instance.plane === undefined
          ? { provider: instance.driver }
          : { provider: instance.driver, subagentControlPlane: instance.plane };
      }),
    getInstanceInfo: (instanceId) => {
      const instance = byId.get(instanceId);
      if (instance === undefined) {
        return Effect.fail(new ProviderUnsupportedError({ provider: instanceId }));
      }
      return Effect.succeed({
        instanceId,
        driverKind: instance.driver,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: instance.driver,
          continuationKey: instance.id,
        },
      } satisfies ProviderInstanceRoutingInfo);
    },
  };
};

const twoAdapters = () => {
  const ownerPlane = makePlane("mgr-1");
  const otherPlane = makePlane("mgr-2");
  const registry = makeLookup([
    { id: "pi-main", driver: ProviderDriverKind.make("pi"), plane: ownerPlane },
    { id: "claude-main", driver: ProviderDriverKind.make("claude"), plane: otherPlane },
  ]);
  return { ownerPlane, otherPlane, registry };
};

describe("subagentControlRouter", () => {
  it.effect("aggregates declared statuses and marks control-plane-less adapters unsupported", () =>
    Effect.gen(function* () {
      const result = yield* routeSubagentControlStatus(
        makeLookup([
          { id: "pi-main", driver: ProviderDriverKind.make("pi"), plane: makePlane("mgr-1") },
          { id: "claude-main", driver: ProviderDriverKind.make("claude") },
        ]),
      );
      expect(result.statuses).toHaveLength(2);
      const piStatus = result.statuses.find((status) => status.providerInstanceId === "pi-main");
      expect(piStatus).toMatchObject({ supported: true, managerId: "mgr-1" });
      expect(piStatus?.capabilities).toMatchObject({ steering: true, normalizedEvents: true });
      const claudeStatus = result.statuses.find(
        (status) => status.providerInstanceId === "claude-main",
      );
      expect(claudeStatus?.supported).toBe(false);
      expect(claudeStatus?.controls.steer.enabled).toBe(false);
    }),
  );

  it.effect("routes steer to the adapter whose manager declared ownership", () =>
    Effect.gen(function* () {
      const { ownerPlane, otherPlane, registry } = twoAdapters();
      const steer = yield* routeSubagentControlSteer(registry, {
        managerId: "mgr-2",
        runId: RUN_ID,
        text: "focus on auth",
      });
      expect(steer).toEqual({ accepted: true });
      expect(otherPlane.events).toEqual([`steer:mgr-2:${RUN_ID}`]);
      expect(ownerPlane.events).toEqual([]);
    }),
  );

  it.effect("routes status, steer, and cancel through a T3-owned additional plane", () =>
    Effect.gen(function* () {
      const plane = makePlane("t3-native:parent");
      const registry = makeLookup([]);
      const status = yield* routeSubagentControlStatus(registry, [plane]);
      expect(status.statuses).toHaveLength(1);
      expect(status.statuses[0]).toMatchObject({
        supported: true,
        managerId: "t3-native:parent",
      });
      yield* routeSubagentControlSteer(
        registry,
        { managerId: "t3-native:parent", runId: RUN_ID, text: "focus" },
        [plane],
      );
      yield* routeSubagentControlCancel(
        registry,
        { managerId: "t3-native:parent", runId: RUN_ID },
        [plane],
      );
      expect(plane.events).toEqual([
        `steer:t3-native:parent:${RUN_ID}`,
        `cancel:t3-native:parent:${RUN_ID}`,
      ]);
    }),
  );

  it.effect("routes cancel by declared manager ownership", () =>
    Effect.gen(function* () {
      const ownerPlane = makePlane("mgr-1");
      const result = yield* routeSubagentControlCancel(
        makeLookup([{ id: "pi-main", driver: ProviderDriverKind.make("pi"), plane: ownerPlane }]),
        { managerId: "mgr-1", runId: RUN_ID },
      );
      expect(result).toEqual({ accepted: true });
      expect(ownerPlane.events).toEqual([`cancel:mgr-1:${RUN_ID}`]);
    }),
  );

  it.effect("fails with unknown-manager when no live adapter declares the manager", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        routeSubagentControlSteer(
          makeLookup([
            { id: "pi-main", driver: ProviderDriverKind.make("pi"), plane: makePlane("mgr-1") },
          ]),
          { managerId: "ghost", runId: RUN_ID, text: "hello" },
        ),
      );
      expect(error).toBeInstanceOf(SubagentControlError);
      expect(error.reason).toBe("unknown-manager");
    }),
  );

  it.effect("continues past a same-manager adapter that does not track the run", () =>
    Effect.gen(function* () {
      // Two live adapters declare the same manager (for example after a
      // reload); the first does not track the run and must not hide the
      // second, which does.
      const shadowPlane = makePlane("mgr-1", { unknownRuns: [RUN_ID] });
      const ownerPlane = makePlane("mgr-1");
      const registry = makeLookup([
        { id: "pi-a", driver: ProviderDriverKind.make("pi"), plane: shadowPlane },
        { id: "pi-b", driver: ProviderDriverKind.make("pi"), plane: ownerPlane },
      ]);
      const steer = yield* routeSubagentControlSteer(registry, {
        managerId: "mgr-1",
        runId: RUN_ID,
        text: "focus on auth",
      });
      expect(steer).toEqual({ accepted: true });
      expect(shadowPlane.events).toEqual([]);
      expect(ownerPlane.events).toEqual([`steer:mgr-1:${RUN_ID}`]);
    }),
  );

  it.effect("reports unknown-run once every same-manager adapter ran out", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        routeSubagentControlCancel(
          makeLookup([
            {
              id: "pi-a",
              driver: ProviderDriverKind.make("pi"),
              plane: makePlane("mgr-1", { unknownRuns: [RUN_ID] }),
            },
            {
              id: "pi-b",
              driver: ProviderDriverKind.make("pi"),
              plane: makePlane("mgr-1", { unknownRuns: [RUN_ID] }),
            },
          ]),
          { managerId: "mgr-1", runId: RUN_ID },
        ),
      );
      expect(error).toBeInstanceOf(SubagentControlError);
      expect(error.reason).toBe("unknown-run");
    }),
  );

  it.effect("preserves non-unknown-run failures without walking further", () =>
    Effect.gen(function* () {
      const failingPlane = makePlane("mgr-1", {
        failWith: new SubagentControlError({ reason: "manager-rejected", detail: "refused" }),
      });
      const fallbackPlane = makePlane("mgr-1");
      const registry = makeLookup([
        { id: "pi-a", driver: ProviderDriverKind.make("pi"), plane: failingPlane },
        { id: "pi-b", driver: ProviderDriverKind.make("pi"), plane: fallbackPlane },
      ]);
      const error = yield* Effect.flip(
        routeSubagentControlCancel(registry, { managerId: "mgr-1", runId: RUN_ID }),
      );
      expect(error).toBeInstanceOf(SubagentControlError);
      expect(error.reason).toBe("manager-rejected");
      expect(fallbackPlane.events).toEqual([]);
    }),
  );

  it("authorizes status reads and owner controls at the orchestration scopes", () => {
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.subagentControlStatus)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.subagentControlSteer)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(ORCHESTRATION_WS_METHODS.subagentControlCancel)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
});

describe("subagentControlRouter binding results", () => {
  const BINDING_INPUT = {
    managerId: "mgr-1",
    runId: RUN_ID,
    nativeRunId: "sa-1",
    activationId: "act-1",
    runBirth: `rb${"c".repeat(22)}`,
    upsertSequence: 4,
  } as const;

  it.effect("routes the exact binding tuple to the declaring manager", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const ownerPlane: ProviderSubagentControlPlaneShape<never> = {
        status: () =>
          Effect.succeed([
            {
              supported: true,
              managerId: "mgr-1",
              protocolVersion: 1,
              capabilities: { ...DECLARED_CAPABILITIES },
              controls: { steer: { enabled: true }, cancel: { enabled: true } },
            } satisfies SubagentControlPlaneStatus,
          ]),
        steer: () => Effect.succeed({ accepted: true } as const),
        cancel: () => Effect.succeed({ accepted: true } as const),
        bindingResult: (input) =>
          Effect.sync(() => {
            events.push(`binding:${input.managerId}:${input.runId}:${input.upsertSequence}`);
            return { accepted: true } as const;
          }),
      };
      const result = yield* routeSubagentControlBindingResult(
        makeLookup([{ id: "pi-main", driver: ProviderDriverKind.make("pi"), plane: ownerPlane }]),
        BINDING_INPUT,
      );
      expect(result).toEqual({ accepted: true });
      expect(events).toEqual([`binding:mgr-1:${RUN_ID}:4`]);
    }),
  );

  it.effect("fails truthfully when no live adapter declares the manager", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        routeSubagentControlBindingResult(
          makeLookup([
            { id: "pi-main", driver: ProviderDriverKind.make("pi"), plane: makePlane("mgr-1") },
          ]),
          { ...BINDING_INPUT, managerId: "ghost" },
        ),
      );
      expect(error).toBeInstanceOf(SubagentControlError);
      expect(error.reason).toBe("unknown-manager");
    }),
  );

  it.effect("fails unsupported on planes without the internal operation", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        routeSubagentControlBindingResult(
          makeLookup([
            { id: "pi-main", driver: ProviderDriverKind.make("pi"), plane: makePlane("mgr-1") },
          ]),
          BINDING_INPUT,
        ),
      );
      expect(error).toBeInstanceOf(SubagentControlError);
      expect(error.reason).toBe("unsupported");
    }),
  );
});
