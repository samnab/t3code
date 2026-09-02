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
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { ProviderAdapterError, ProviderUnsupportedError } from "./Errors.ts";
import type {
  ProviderSubagentBindingResultInput,
  ProviderSubagentControlPlaneShape,
} from "./Services/ProviderAdapter.ts";
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

const isControlError = Schema.is(SubagentControlError);

const normalizeControlFailure = (cause: unknown): SubagentControlError =>
  isControlError(cause)
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

/** Find every live adapter whose declared status names the manager. */
const findOwnerPlanes = (
  registry: SubagentControlAdapterLookup,
  managerId: string,
): Effect.Effect<ReadonlyArray<ProviderSubagentControlPlaneShape<ProviderAdapterError>>, never> =>
  Effect.gen(function* () {
    const instanceIds = yield* registry.listInstances().pipe(Effect.orElseSucceed(() => []));
    const planes: Array<ProviderSubagentControlPlaneShape<ProviderAdapterError>> = [];
    for (const instanceId of instanceIds) {
      const adapter = yield* registry.getByInstance(instanceId).pipe(Effect.option);
      const plane = Option.isNone(adapter) ? undefined : adapter.value.subagentControlPlane;
      if (plane === undefined) continue;
      const statuses = yield* plane.status().pipe(Effect.option);
      if (
        Option.isSome(statuses) &&
        statuses.value.some((status) => status.supported && status.managerId === managerId)
      ) {
        planes.push(plane);
      }
    }
    return planes;
  });

const routeToOwner = (
  registry: SubagentControlAdapterLookup,
  managerId: string,
  attempt: (
    plane: ProviderSubagentControlPlaneShape<ProviderAdapterError>,
  ) => Effect.Effect<
    OrchestrationSubagentControlActionResult,
    ProviderAdapterError | SubagentControlError
  >,
): Effect.Effect<OrchestrationSubagentControlActionResult, SubagentControlError> =>
  Effect.gen(function* () {
    const planes = yield* findOwnerPlanes(registry, managerId);
    if (planes.length === 0) {
      return yield* new SubagentControlError({
        reason: "unknown-manager",
        detail: `No live provider session declares subagent manager '${managerId}'.`,
      });
    }
    // Two live adapters can declare the same manager (for example after a
    // reload). An adapter whose session does not track the run must not hide
    // the one that does: keep walking on unknown-run, preserve other errors.
    let unknownRun: SubagentControlError = new SubagentControlError({
      reason: "unknown-run",
      detail: `Manager '${managerId}' does not track the requested run.`,
    });
    for (const plane of planes) {
      const outcome = yield* Effect.result(attempt(plane));
      if (Result.isSuccess(outcome)) return outcome.success;
      const error = normalizeControlFailure(outcome.failure);
      if (error.reason === "unknown-run") {
        unknownRun = error;
        continue;
      }
      return yield* error;
    }
    return yield* unknownRun;
  });

export const routeSubagentControlSteer = (
  registry: SubagentControlAdapterLookup,
  input: OrchestrationSubagentControlSteerInput,
): Effect.Effect<OrchestrationSubagentControlActionResult, SubagentControlError> =>
  routeToOwner(registry, input.managerId, (plane) => plane.steer(input));

export const routeSubagentControlCancel = (
  registry: SubagentControlAdapterLookup,
  input: OrchestrationSubagentControlCancelInput,
): Effect.Effect<OrchestrationSubagentControlActionResult, SubagentControlError> =>
  routeToOwner(registry, input.managerId, (plane) => plane.cancel(input));

/**
 * Route one exact Phase 1.5 `run-upsert-result` to the live manager that
 * declared ownership of the binding. The attempt fails truthfully on planes
 * without the internal binding-result operation instead of inferring
 * support, and an unknown manager surfaces exactly like steer/cancel.
 */
export const routeSubagentControlBindingResult = (
  registry: SubagentControlAdapterLookup,
  input: ProviderSubagentBindingResultInput,
): Effect.Effect<OrchestrationSubagentControlActionResult, SubagentControlError> =>
  routeToOwner(registry, input.managerId, (plane) =>
    plane.bindingResult === undefined
      ? Effect.fail(
          new SubagentControlError({
            reason: "unsupported",
            detail: "This provider session cannot accept subagent run binding results.",
          }),
        )
      : plane.bindingResult(input),
  );
