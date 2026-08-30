/**
 * Subagent control-plane routing across live provider adapters.
 *
 * Steer/cancel are routed by the manager id each adapter declared during
 * capability negotiation — not by the current thread binding — so an owner
 * manager stays authoritative for its runs even after the visible thread
 * moved to another provider. Adapters without a control plane contribute an
 * explicit unsupported status entry and are never consulted for controls.
 *
 * @module provider/subagentControlRouter
 */
import {
  SubagentControlError,
  type OrchestrationSubagentControlActionResult,
  type OrchestrationSubagentControlCancelInput,
  type OrchestrationSubagentControlSteerInput,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type SubagentControlPlaneStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderAdapterError, ProviderUnsupportedError } from "./Errors.ts";
import type { ProviderSubagentControlPlaneShape } from "./Services/ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./Services/ProviderAdapterRegistry.ts";

/** The only adapter surface the router touches. */
export interface SubagentControlAdapter {
  readonly provider: ProviderDriverKind;
  readonly subagentControlPlane?: ProviderSubagentControlPlaneShape<ProviderAdapterError>;
}

/** Structural lookup subset of ProviderAdapterRegistry the router needs. */
export interface SubagentControlAdapterLookup {
  readonly listInstances: () => Effect.Effect<
    ReadonlyArray<ProviderInstanceId>,
    ProviderUnsupportedError
  >;
  readonly getByInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<SubagentControlAdapter, ProviderUnsupportedError>;
  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderUnsupportedError>;
}

const MAX_STATUSES = 64;

const unsupportedStatus = (reason: string): SubagentControlPlaneStatus => ({
  supported: false,
  reason,
  controls: {
    steer: { enabled: false, reason },
    cancel: { enabled: false, reason },
  },
});

const isSubagentControlError = (cause: unknown): cause is SubagentControlError =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  cause._tag === "SubagentControlError";

const normalizeControlFailure = (cause: unknown): SubagentControlError =>
  isSubagentControlError(cause)
    ? cause
    : new SubagentControlError({
        reason: "routing-failed",
        ...(typeof cause === "object" && cause !== null && "message" in cause
          ? { detail: String(cause.message).slice(0, 512) }
          : {}),
      });

/**
 * Collect declared control-plane status from every live adapter, stamping
 * each entry with its routing instance id. Bounded to MAX_STATUSES entries.
 */
export const routeSubagentControlStatus = (
  registry: SubagentControlAdapterLookup,
): Effect.Effect<{ readonly statuses: ReadonlyArray<SubagentControlPlaneStatus> }, never> =>
  Effect.gen(function* () {
    const instanceIds = yield* registry.listInstances().pipe(Effect.orElseSucceed(() => []));
    const statuses: Array<SubagentControlPlaneStatus> = [];
    for (const instanceId of instanceIds.slice(0, MAX_STATUSES)) {
      const info = yield* registry.getInstanceInfo(instanceId).pipe(Effect.option);
      const adapter = yield* registry.getByInstance(instanceId).pipe(Effect.option);
      if (Option.isNone(adapter)) {
        if (Option.isSome(info)) {
          statuses.push({
            providerInstanceId: instanceId,
            ...unsupportedStatus("Provider instance is not live."),
          });
        }
        continue;
      }
      const plane = adapter.value.subagentControlPlane;
      if (plane === undefined) {
        statuses.push({
          provider: info._tag === "Some" ? info.value.driverKind : undefined,
          providerInstanceId: instanceId,
          ...unsupportedStatus(
            `Provider '${Option.isSome(info) ? info.value.driverKind : adapter.value.provider}' does not expose a subagent control plane.`,
          ),
        });
        continue;
      }
      const entries = yield* plane.status().pipe(Effect.option);
      if (Option.isNone(entries)) {
        statuses.push({
          provider: info._tag === "Some" ? info.value.driverKind : undefined,
          providerInstanceId: instanceId,
          ...unsupportedStatus("Subagent control-plane status is unavailable."),
        });
        continue;
      }
      for (const entry of entries.value.slice(0, MAX_STATUSES - statuses.length)) {
        statuses.push({ ...entry, providerInstanceId: instanceId });
      }
    }
    return { statuses };
  });

/** Find the live adapter that declared the requested manager, if any. */
const findOwnerPlane = (
  registry: SubagentControlAdapterLookup,
  managerId: string,
): Effect.Effect<
  | {
      readonly _tag: "found";
      readonly plane: ProviderSubagentControlPlaneShape<ProviderAdapterError>;
    }
  | { readonly _tag: "unknown-manager" },
  never
> =>
  Effect.gen(function* () {
    const instanceIds = yield* registry.listInstances().pipe(Effect.orElseSucceed(() => []));
    for (const instanceId of instanceIds) {
      const adapter = yield* registry.getByInstance(instanceId).pipe(Effect.option);
      if (Option.isNone(adapter)) continue;
      const plane = adapter.value.subagentControlPlane;
      if (plane === undefined) continue;
      const statuses = yield* plane.status().pipe(Effect.option);
      if (
        Option.isSome(statuses) &&
        statuses.value.some((status) => status.supported && status.managerId === managerId)
      ) {
        return { _tag: "found" as const, plane };
      }
    }
    return { _tag: "unknown-manager" as const };
  });

export const routeSubagentControlSteer = (
  registry: SubagentControlAdapterLookup,
  input: OrchestrationSubagentControlSteerInput,
): Effect.Effect<OrchestrationSubagentControlActionResult, SubagentControlError> =>
  Effect.gen(function* () {
    const owner = yield* findOwnerPlane(registry, input.managerId);
    if (owner._tag === "unknown-manager") {
      return yield* new SubagentControlError({
        reason: "unknown-manager",
        detail: `No live provider session declares subagent manager '${input.managerId}'.`,
      });
    }
    return yield* owner.plane.steer(input).pipe(Effect.mapError(normalizeControlFailure));
  });

export const routeSubagentControlCancel = (
  registry: SubagentControlAdapterLookup,
  input: OrchestrationSubagentControlCancelInput,
): Effect.Effect<OrchestrationSubagentControlActionResult, SubagentControlError> =>
  Effect.gen(function* () {
    const owner = yield* findOwnerPlane(registry, input.managerId);
    if (owner._tag === "unknown-manager") {
      return yield* new SubagentControlError({
        reason: "unknown-manager",
        detail: `No live provider session declares subagent manager '${input.managerId}'.`,
      });
    }
    return yield* owner.plane.cancel(input).pipe(Effect.mapError(normalizeControlFailure));
  });
