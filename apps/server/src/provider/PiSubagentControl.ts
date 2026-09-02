/**
 * PiSubagentControl — typed bridge for the native Pi subagent manager's
 * explicit command/JSONL control-plane contract.
 *
 * The manager is exposed by the user's Pi subagent extension as one
 * registered extension slash command. Standard Pi RPC has no arbitrary
 * extension-tool invocation, and an UNREGISTERED slash command sent through
 * `prompt` would silently become a model prompt — so callers must prove the
 * command exists via `get_commands` before ever sending one. This module owns
 * that contract: versioned base64url command envelopes, bounded decoding of
 * manager records carried by Pi's supported custom-entry channel,
 * protocol/capability negotiation, and the idempotent per-run state machine that rejects wrong
 * owners, stale/out-of-order sequences, and late activation events.
 *
 * It deliberately knows nothing about transports or tasks; `PiAdapter` feeds
 * it records and maps accepted effects onto `task.*` runtime events.
 *
 * @module provider/PiSubagentControl
 */
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { piRecordString as recordString } from "./piRpc.ts";

/**
 * The manager's extension slash command. Presence in `get_commands` is the
 * only permission to send it; absence must surface as an explicit
 * unsupported status and must never degrade into a model prompt.
 */
export const SUBAGENT_MANAGER_COMMAND = "subagent:t3-control";

/** Reserved Pi custom-entry type and manager-envelope `type` tag. */
export const MANAGER_RECORD_TYPE = "t3.subagent.v1";

/** The only manager protocol version this bridge accepts. */
export const MANAGER_PROTOCOL_VERSION = 1;

/** Manager-declared identifiers must survive embedding in T3 task ids. */
const ManagerIdString = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const ManagerSequence = Schema.Int.check(Schema.isGreaterThan(0));
const ManagerStatus = Schema.Literals(["running", "done", "error", "cancelled"]);
const ManagerHarness = Schema.Literals(["pi", "claude", "codex"]);
/** `rb` + the first 22 base64url characters of the snapshot digest. */
const ManagerRunBirth = Schema.String.check(Schema.isPattern(/^rb[A-Za-z0-9_-]{22}$/));

/** The capability booleans a negotiation record must declare. */
export interface ManagerCapabilities {
  readonly normalizedEvents: boolean;
  readonly stableActivations: boolean;
  readonly ownerRouting: boolean;
  readonly steering: boolean;
  readonly cancellation: boolean;
  readonly reloadRestore: boolean;
  readonly scheduling: boolean;
  readonly nativeChildProjection: boolean;
  readonly deliveryAcknowledgements: boolean;
  /** Phase 1.5; absent on managers that predate the capability. */
  readonly childTranscripts: boolean;
}

const ManagerCapabilitiesSchema = Schema.Struct({
  normalizedEvents: Schema.Boolean,
  stableActivations: Schema.Boolean,
  ownerRouting: Schema.Boolean,
  steering: Schema.Boolean,
  cancellation: Schema.Boolean,
  reloadRestore: Schema.Boolean,
  scheduling: Schema.Boolean,
  nativeChildProjection: Schema.Boolean,
  deliveryAcknowledgements: Schema.Boolean,
  childTranscripts: Schema.optional(Schema.Boolean),
});

const NegotiationRecordSchema = Schema.Struct({
  type: Schema.Literal(MANAGER_RECORD_TYPE),
  kind: Schema.Literal("negotiation"),
  id: ManagerIdString,
  managerId: ManagerIdString,
  protocolVersion: Schema.Int,
  capabilities: ManagerCapabilitiesSchema,
});

const RunUpsertRecordSchema = Schema.Struct({
  type: Schema.Literal(MANAGER_RECORD_TYPE),
  kind: Schema.Literal("run-upsert"),
  managerId: ManagerIdString,
  sequence: ManagerSequence,
  runId: ManagerIdString,
  activationId: ManagerIdString,
  status: ManagerStatus,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  harness: Schema.optional(ManagerHarness),
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  summary: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(8_192))),
  // Phase 1.5 binding evidence on the allocating upsert of an enhanced
  // manager; absent on stock managers, which stay summary-only.
  runBirth: Schema.optional(ManagerRunBirth),
  upsertSequence: Schema.optional(ManagerSequence),
});

const TranscriptItemRecordSchema = Schema.Struct({
  type: Schema.Literal(MANAGER_RECORD_TYPE),
  kind: Schema.Literal("transcript-item"),
  managerId: ManagerIdString,
  runId: ManagerIdString,
  activationId: ManagerIdString,
  runBirth: ManagerRunBirth,
  transcriptSequence: ManagerSequence,
  item: Schema.Struct({
    kind: Schema.Literals(["user", "assistant", "toolResult"]),
    // Decoded length bound only: T3 re-redacts and re-truncates at its own
    // boundary before anything is persisted.
    text: Schema.String.check(Schema.isMaxLength(65_536)),
    truncated: Schema.Boolean,
    upstreamTruncated: Schema.Boolean,
    createdAt: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  }),
});

const AckRecordSchema = Schema.Struct({
  type: Schema.Literal(MANAGER_RECORD_TYPE),
  kind: Schema.Literal("ack"),
  id: ManagerIdString,
  accepted: Schema.Boolean,
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});

export type ManagerRunUpsert = typeof RunUpsertRecordSchema.Type;
export type ManagerTranscriptItem = typeof TranscriptItemRecordSchema.Type;

export type ManagerRecord =
  | typeof NegotiationRecordSchema.Type
  | typeof RunUpsertRecordSchema.Type
  | typeof TranscriptItemRecordSchema.Type
  | typeof AckRecordSchema.Type;

export interface ManagerRunReplayState {
  readonly pendingManagerRunUpserts: ManagerRunUpsert[];
  managerNegotiating: boolean;
}

const decodeNegotiation = Schema.decodeUnknownOption(NegotiationRecordSchema);
const decodeRunUpsert = Schema.decodeUnknownOption(RunUpsertRecordSchema);
const decodeTranscriptItem = Schema.decodeUnknownOption(TranscriptItemRecordSchema);
const decodeAck = Schema.decodeUnknownOption(AckRecordSchema);

/**
 * Bounded decode of one manager envelope. Malformed, non-compliant, or
 * oversized records return `undefined` and are dropped by the caller.
 */
export function decodeManagerRecord(record: unknown): ManagerRecord | undefined {
  if (recordString(record, "type") !== MANAGER_RECORD_TYPE) return undefined;
  switch (recordString(record, "kind")) {
    case "negotiation": {
      const decoded = decodeNegotiation(record);
      return decoded._tag === "Some" ? decoded.value : undefined;
    }
    case "run-upsert": {
      const decoded = decodeRunUpsert(record);
      return decoded._tag === "Some" ? decoded.value : undefined;
    }
    case "transcript-item": {
      const decoded = decodeTranscriptItem(record);
      return decoded._tag === "Some" ? decoded.value : undefined;
    }
    case "ack": {
      const decoded = decodeAck(record);
      return decoded._tag === "Some" ? decoded.value : undefined;
    }
    default:
      return undefined;
  }
}

export const drainManagerRunReplay = <A, E, R>(
  state: ManagerRunReplayState,
  apply: (record: ManagerRunUpsert) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    let record: ManagerRunUpsert | undefined;
    while ((record = state.pendingManagerRunUpserts.shift()) !== undefined) {
      yield* apply(record);
    }
    state.managerNegotiating = false;
  });

// ── command envelopes ────────────────────────────────────────

export type ControlEnvelope =
  | {
      readonly v: 1;
      readonly op: "negotiate";
      readonly id: string;
      /** T3's Phase 1.5 offer; the capability is active only when both sides declare it. */
      readonly capabilities?: { readonly childTranscripts: true };
      /**
       * Durable per-run replay watermarks T3 re-sends at negotiation,
       * renegotiation, and reconnect so the producer re-emits retained
       * finalized items above them.
       */
      readonly replay?: ReadonlyArray<{ readonly runId: string; readonly watermark: number }>;
    }
  | {
      readonly v: 1;
      readonly op: "steer";
      readonly id: string;
      readonly managerId: string;
      readonly runId: string;
      readonly activationId: string;
      readonly text: string;
    }
  | {
      readonly v: 1;
      readonly op: "cancel";
      readonly id: string;
      readonly managerId: string;
      readonly runId: string;
      readonly activationId: string;
    }
  | {
      readonly v: 1;
      readonly op: "run-upsert-result";
      readonly id: string;
      readonly managerId: string;
      readonly runId: string;
      readonly activationId: string;
      readonly runBirth: string;
      readonly upsertSequence: number;
      readonly t3RunId: string;
    };

/**
 * One-argument safe encoding for the command prompt:
 * `/<SUBAGENT_MANAGER_COMMAND> <encoded>`. base64url keeps the envelope a
 * single shell/JSON-safe token with no whitespace or metacharacters.
 */
export function encodeControlEnvelope(envelope: ControlEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decodeControlEnvelope(encoded: string): ControlEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record["v"] !== MANAGER_PROTOCOL_VERSION) return undefined;
    switch (record["op"]) {
      case "negotiate":
      case "steer":
      case "cancel":
      case "run-upsert-result":
        return parsed as ControlEnvelope;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

// ── correlated exchanges ─────────────────────────────────────

/**
 * Send a command and await its correlated reply record. The reply Deferred is
 * registered before the command is sent, so a manager that replies before the
 * awaiting fiber resumes can never have its record dropped, and cleanup runs
 * on every exit — send failure, timeout, and interruption included.
 */
export const exchangeManagerRecord = <E>(
  pending: Map<string, Deferred.Deferred<ManagerRecord>>,
  correlationId: string,
  timeoutMs: number,
  send: Effect.Effect<void, E>,
): Effect.Effect<ManagerRecord | undefined, E> =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<ManagerRecord>();
    pending.set(correlationId, deferred);
    yield* send;
    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.map(Option.getOrUndefined),
    );
  }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(correlationId))));

// ── negotiation ──────────────────────────────────────────────

export interface NegotiatedManagerControl {
  readonly managerId: string;
  readonly protocolVersion: number;
  readonly capabilities: ManagerCapabilities;
}

/**
 * A negotiated manager is authoritative only when it declared the exact
 * supported protocol version. Capability claims are never inferred from
 * command presence or record shape.
 */
export function negotiationFromRecord(
  record: ManagerRecord & { kind: "negotiation" },
):
  | { readonly ok: true; readonly control: NegotiatedManagerControl }
  | { readonly ok: false; readonly reason: string } {
  if (record.protocolVersion !== MANAGER_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `Pi subagent manager declared protocol version ${record.protocolVersion}; T3 Code supports ${MANAGER_PROTOCOL_VERSION}.`,
    };
  }
  return {
    ok: true,
    control: {
      managerId: record.managerId,
      protocolVersion: record.protocolVersion,
      capabilities: {
        ...record.capabilities,
        childTranscripts: record.capabilities.childTranscripts === true,
      },
    },
  };
}

// ── per-control availability ─────────────────────────────────

export interface ControlAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface ControlAvailabilities {
  readonly steer: ControlAvailability;
  readonly cancel: ControlAvailability;
}

const CONTROL_UNAVAILABLE = (capability: string): string =>
  `Pi subagent manager does not declare the ${capability} capability.`;

/**
 * Steer and cancel require normalized ownership, delivery acknowledgements,
 * and their individual capability. Stable activation IDs are not required:
 * routing uses the current activation from the normalized run registry.
 */
export function deriveControlAvailabilities(
  capabilities: ManagerCapabilities,
): ControlAvailabilities {
  const routed = (declared: boolean, capability: string): ControlAvailability =>
    !capabilities.normalizedEvents
      ? { enabled: false, reason: CONTROL_UNAVAILABLE("normalizedEvents") }
      : !capabilities.ownerRouting
        ? { enabled: false, reason: CONTROL_UNAVAILABLE("ownerRouting") }
        : !capabilities.deliveryAcknowledgements
          ? { enabled: false, reason: CONTROL_UNAVAILABLE("deliveryAcknowledgements") }
          : declared
            ? { enabled: true }
            : { enabled: false, reason: CONTROL_UNAVAILABLE(capability) };
  return {
    steer: routed(capabilities.steering, "steering"),
    cancel: routed(capabilities.cancellation, "cancellation"),
  };
}

// ── normalized run-upsert state machine ──────────────────────

export type AppliedRunUpsert =
  | {
      readonly accepted: true;
      readonly effect: "start";
      /** Live activation this start replaced, if any. */
      readonly superseded?: string;
      /** Oldest open run removed to preserve the manager's run bound. */
      readonly evicted?: { readonly runId: string; readonly activationId: string };
    }
  | { readonly accepted: true; readonly effect: "update" | "complete" }
  | {
      readonly accepted: false;
      readonly reason: "manager-mismatch" | "stale-sequence" | "late-activation";
    };

/** The canonical manager keeps at most 50 runs; tracking never outgrows it. */
const MAX_TRACKED_RUNS = 50;
const MAX_FINALIZED_ACTIVATIONS_PER_RUN = 50;

/**
 * Idempotent application of normalized run-upserts for one negotiated
 * manager. The manager's event sequence is global and must advance
 * monotonically across runs; events from another manager, sequences that do
 * not advance, and events for an activation that already reached a terminal
 * state are rejected — a reload or root handoff cannot resurrect an old
 * activation.
 */
export function makeManagerRunRegistry(managerId: string) {
  // Open runs: native runId → live activationId, insertion-ordered.
  const runs = new Map<string, string>();
  const finalizedActivations = new Map<string, Set<string>>();
  let lastSequence = 0;

  const rememberFinalized = (runId: string, activationId: string) => {
    let finalizedForRun = finalizedActivations.get(runId);
    if (finalizedForRun === undefined) {
      finalizedForRun = new Set();
      if (finalizedActivations.size >= MAX_TRACKED_RUNS) {
        const oldest = finalizedActivations.keys().next().value;
        if (oldest !== undefined) finalizedActivations.delete(oldest);
      }
      finalizedActivations.set(runId, finalizedForRun);
    }
    if (finalizedForRun.size >= MAX_FINALIZED_ACTIVATIONS_PER_RUN) {
      const oldest = finalizedForRun.values().next().value;
      if (oldest !== undefined) finalizedForRun.delete(oldest);
    }
    finalizedForRun.add(activationId);
  };

  const apply = (record: ManagerRunUpsert): AppliedRunUpsert => {
    if (record.managerId !== managerId) return { accepted: false, reason: "manager-mismatch" };
    if (record.sequence <= lastSequence) return { accepted: false, reason: "stale-sequence" };
    const existing = runs.get(record.runId);
    if (existing !== undefined && existing === record.activationId) {
      if (finalizedActivations.get(record.runId)?.has(record.activationId)) {
        return { accepted: false, reason: "late-activation" };
      }
      lastSequence = record.sequence;
      if (record.status !== "running") {
        rememberFinalized(record.runId, record.activationId);
        runs.delete(record.runId);
        return { accepted: true, effect: "complete" };
      }
      return { accepted: true, effect: "update" };
    }
    // A different activation for this run: only fresh (never finalized)
    // activations are applied; events for settled activations are late and
    // rejected, and they never poison the currently tracked activation.
    if (finalizedActivations.get(record.runId)?.has(record.activationId)) {
      return { accepted: false, reason: "late-activation" };
    }
    if (record.status === "running") {
      // Replacing a live activation settles the old one; the registry reports
      // it so the adapter can stop the old task row before starting the new.
      if (existing !== undefined) rememberFinalized(record.runId, existing);
      let evicted: { readonly runId: string; readonly activationId: string } | undefined;
      if (existing === undefined && runs.size >= MAX_TRACKED_RUNS) {
        const oldestRunId = runs.keys().next().value;
        const oldestActivationId = oldestRunId === undefined ? undefined : runs.get(oldestRunId);
        if (oldestRunId !== undefined && oldestActivationId !== undefined) {
          evicted = { runId: oldestRunId, activationId: oldestActivationId };
          rememberFinalized(oldestRunId, oldestActivationId);
          runs.delete(oldestRunId);
        }
      }
      runs.set(record.runId, record.activationId);
      lastSequence = record.sequence;
      return {
        accepted: true,
        effect: "start",
        ...(existing !== undefined ? { superseded: existing } : {}),
        ...(evicted !== undefined ? { evicted } : {}),
      };
    }
    // Terminal event for an activation this bridge never saw running: apply
    // it as a complete so the row does not dangle as a zombie.
    rememberFinalized(record.runId, record.activationId);
    lastSequence = record.sequence;
    return { accepted: true, effect: "complete" };
  };

  const openRuns = (): ReadonlyArray<{
    readonly runId: string;
    readonly activationId: string;
    readonly status: "running";
  }> =>
    Array.from(runs.entries(), ([runId, activationId]) => ({
      runId,
      activationId,
      status: "running" as const,
    }));

  const findOpenRun = (runId: string): { activationId: string } | undefined => {
    const activationId = runs.get(runId);
    return activationId === undefined ? undefined : { activationId };
  };

  return { apply, openRuns, findOpenRun };
}

export type ManagerRunRegistry = ReturnType<typeof makeManagerRunRegistry>;

// ── Phase 1.5 run binding tuples ─────────────────────────────

/** The five routing members plus the T3 id they resolved to. */
export interface ManagerRunBindingTuple {
  readonly managerId: string;
  readonly nativeRunId: string;
  readonly activationId: string;
  readonly runBirth: string;
  readonly upsertSequence: number;
  readonly t3RunId: string;
}

/** Bindings are bounded; FIFO eviction keeps memory flat. */
const MAX_TRACKED_RUN_BINDINGS = 256;

/**
 * Bounded open/terminal binding tuples for one adapter session. Installing
 * is idempotent for an identical tuple and rejects a conflicting T3 id or
 * tuple for the same native binding — the rule behind `run-upsert-result`
 * retries. Lookup by native binding is what validates later transcript
 * items and binding results as a five-member unit.
 */
export function makeRunBindingTracker() {
  const byT3RunId = new Map<string, ManagerRunBindingTuple & { acked: boolean }>();

  const evictIfNeeded = () => {
    if (byT3RunId.size >= MAX_TRACKED_RUN_BINDINGS) {
      const oldest = byT3RunId.keys().next().value;
      if (oldest !== undefined) byT3RunId.delete(oldest);
    }
  };

  const install = (
    tuple: ManagerRunBindingTuple,
  ): { readonly ok: true } | { readonly ok: false; readonly conflict: string } => {
    for (const existing of byT3RunId.values()) {
      if (
        existing.managerId === tuple.managerId &&
        existing.nativeRunId === tuple.nativeRunId &&
        existing.activationId === tuple.activationId &&
        existing.runBirth === tuple.runBirth &&
        existing.upsertSequence === tuple.upsertSequence
      ) {
        return existing.t3RunId === tuple.t3RunId
          ? { ok: true }
          : { ok: false, conflict: `binding already resolved to T3 run ${existing.t3RunId}` };
      }
    }
    evictIfNeeded();
    byT3RunId.set(tuple.t3RunId, { ...tuple, acked: false });
    return { ok: true };
  };

  const markAcked = (t3RunId: string) => {
    const existing = byT3RunId.get(t3RunId);
    if (existing === undefined) return false;
    byT3RunId.set(t3RunId, { ...existing, acked: true });
    return true;
  };

  const isAcked = (t3RunId: string) => byT3RunId.get(t3RunId)?.acked === true;

  const findByT3RunId = (t3RunId: string) => byT3RunId.get(t3RunId);

  /** Resolve a producer-side binding (manager + native run + activation + birth) to its tuple. */
  const findByNativeBinding = (input: {
    readonly managerId: string;
    readonly nativeRunId: string;
    readonly activationId: string;
    readonly runBirth: string;
  }) => {
    for (const entry of byT3RunId.values()) {
      if (
        entry.managerId === input.managerId &&
        entry.nativeRunId === input.nativeRunId &&
        entry.activationId === input.activationId &&
        entry.runBirth === input.runBirth
      ) {
        return entry;
      }
    }
    return undefined;
  };

  const unackedT3RunIds = () =>
    Array.from(byT3RunId.values())
      .filter((entry) => !entry.acked)
      .map((entry) => entry.t3RunId)
      .slice(0, 64);

  return { install, markAcked, isAcked, findByT3RunId, findByNativeBinding, unackedT3RunIds };
}

export type ManagerRunBindingTracker = ReturnType<typeof makeRunBindingTracker>;
