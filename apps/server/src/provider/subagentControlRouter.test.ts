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
  routeSubagentControlCancel,
  routeSubagentControlStatus,
  routeSubagentControlSteer,
  type SubagentControlAdapterLookup,
} from "./subagentControlRouter.ts";

const RUN_ID = RuntimeTaskId.make("pi:epoch:act-1:sa-1");

interface RecordingPlane extends ProviderSubagentControlPlaneShape<never> {
  readonly events: string[];
}

const makePlane = (managerId: string): RecordingPlane => {
  const events: string[] = [];
  return {
    events,
    status: () =>
      Effect.succeed([
        {
          supported: true,
          managerId,
          protocolVersion: 1,
          controls: { steer: { enabled: true }, cancel: { enabled: true } },
        } satisfies SubagentControlPlaneStatus,
      ]),
    steer: (input) =>
      Effect.gen(function* () {
        if (input.managerId !== managerId) {
          return yield* new SubagentControlError({ reason: "manager-mismatch" });
        }
        events.push(`steer:${input.managerId}:${input.runId}`);
        return { accepted: true } as const;
      }),
    cancel: (input) =>
      Effect.gen(function* () {
        if (input.managerId !== managerId) {
          return yield* new SubagentControlError({ reason: "manager-mismatch" });
        }
        events.push(`cancel:${input.managerId}:${input.runId}`);
        return { accepted: true } as const;
      }),
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
