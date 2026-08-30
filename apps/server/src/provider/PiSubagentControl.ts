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
 * the manager's dedicated stdout JSON records, protocol/capability
 * negotiation, and the idempotent per-run state machine that rejects wrong
 * owners, stale/out-of-order sequences, and late activation events.
 *
 * It deliberately knows nothing about transports or tasks; `PiAdapter` feeds
 * it records and maps accepted effects onto `task.*` runtime events.
 *
 * @module provider/PiSubagentControl
 */
import * as Schema from "effect/Schema";

import { piRecordString as recordString, type PiRpcRecord } from "./piRpc.ts";

/**
 * The manager's extension slash command. Presence in `get_commands` is the
 * only permission to send it; absence must surface as an explicit
 * unsupported status and must never degrade into a model prompt.
 */
export const SUBAGENT_MANAGER_COMMAND = "subagent:t3-control";

/** Record `type` tag emitted by a compliant manager on stdout. */
export const MANAGER_RECORD_TYPE = "t3.subagent.v1";

/** The only manager protocol version this bridge accepts. */
export const MANAGER_PROTOCOL_VERSION = 1;

/** Manager-declared identifiers must survive embedding in T3 task ids. */
const ManagerIdString = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));
const ManagerSequence = Schema.Int.check(Schema.isGreaterThan(0));
const ManagerStatus = Schema.Literals(["running", "done", "error", "cancelled"]);
const ManagerHarness = Schema.Literals(["pi", "claude", "codex"]);

/** The nine capability booleans a negotiation record must declare. */
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
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  harness: Schema.optional(ManagerHarness),
  model: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(8_192))),
});

const AckRecordSchema = Schema.Struct({
  type: Schema.Literal(MANAGER_RECORD_TYPE),
  kind: Schema.Literal("ack"),
  id: ManagerIdString,
  accepted: Schema.Boolean,
  error: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
});

export type ManagerRunUpsert = typeof RunUpsertRecordSchema.Type;

export type ManagerRecord =
  | typeof NegotiationRecordSchema.Type
  | typeof RunUpsertRecordSchema.Type
  | typeof AckRecordSchema.Type;

const decodeNegotiation = Schema.decodeUnknownOption(NegotiationRecordSchema);
const decodeRunUpsert = Schema.decodeUnknownOption(RunUpsertRecordSchema);
const decodeAck = Schema.decodeUnknownOption(AckRecordSchema);

/**
 * Bounded decode of one manager stdout record. Malformed, non-compliant, or
 * oversized records return `undefined` and are dropped by the caller — a
 * chatty or legacy manager must never take a session down.
 */
export function decodeManagerRecord(record: PiRpcRecord): ManagerRecord | undefined {
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
    case "ack": {
      const decoded = decodeAck(record);
      return decoded._tag === "Some" ? decoded.value : undefined;
    }
    default:
      return undefined;
  }
}

// ── command envelopes ────────────────────────────────────────

export type ControlEnvelope =
  | { readonly v: 1; readonly op: "negotiate"; readonly id: string }
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
  const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== MANAGER_PROTOCOL_VERSION) return undefined;
  switch (record["op"]) {
    case "negotiate":
    case "steer":
    case "cancel":
      return parsed as ControlEnvelope;
    default:
      return undefined;
  }
}

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
      capabilities: { ...record.capabilities },
    },
  };
}

// ── per-control availability ─────────────────────────────────

export interface ControlAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface ControlAvailabilities {
  readonly status: ControlAvailability;
  readonly steer: ControlAvailability;
  readonly cancel: ControlAvailability;
}

const CONTROL_UNAVAILABLE = (capability: string): string =>
  `Pi subagent manager does not declare the ${capability} capability.`;

export function deriveControlAvailabilities(
  capabilities: ManagerCapabilities,
): ControlAvailabilities {
  const routed = (declared: boolean, capability: string): ControlAvailability =>
    !capabilities.ownerRouting
      ? { enabled: false, reason: CONTROL_UNAVAILABLE("ownerRouting") }
      : declared
        ? { enabled: true }
        : { enabled: false, reason: CONTROL_UNAVAILABLE(capability) };
  return {
    status: capabilities.normalizedEvents
      ? { enabled: true }
      : { enabled: false, reason: CONTROL_UNAVAILABLE("normalizedEvents") },
    steer: routed(capabilities.steering, "steering"),
    cancel: routed(capabilities.cancellation, "cancellation"),
  };
}

export const disabledControlAvailabilities = (reason: string): ControlAvailabilities => ({
  status: { enabled: false, reason },
  steer: { enabled: false, reason },
  cancel: { enabled: false, reason },
});

// ── normalized run-upsert state machine ──────────────────────

export type AppliedRunUpsert =
  | { readonly accepted: true; readonly effect: "start" | "update" | "complete" }
  | {
      readonly accepted: false;
      readonly reason: "manager-mismatch" | "stale-sequence" | "late-activation";
    };

interface ManagerRunState {
  readonly activationId: string;
  lastSequence: number;
  status: (typeof ManagerStatus.Type)[number];
  started: boolean;
}

const MAX_TRACKED_RUNS = 256;

/**
 * Idempotent application of normalized run-upserts for one negotiated
 * manager. Events from another manager, sequences that do not advance, and
 * events for an activation that already reached a terminal state are
 * rejected — a reload or root handoff cannot resurrect an old activation.
 */
export function makeManagerRunRegistry(managerId: string) {
  const runs = new Map<string, ManagerRunState>();
  const finalizedActivations = new Map<string, Set<string>>();

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
    finalizedForRun.add(activationId);
  };

  const apply = (record: ManagerRunUpsert): AppliedRunUpsert => {
    if (record.managerId !== managerId) return { accepted: false, reason: "manager-mismatch" };
    const existing = runs.get(record.runId);
    if (existing !== undefined && existing.activationId !== record.activationId) {
      // The tracked activation is being superseded or revisited: whatever the
      // manager previously had live for this run is settled from now on, so
      // its late events can never resurrect the old row.
      rememberFinalized(record.runId, existing.activationId);
    }
    if (existing !== undefined && existing.activationId === record.activationId) {
      if (record.sequence <= existing.lastSequence) {
        return { accepted: false, reason: "stale-sequence" };
      }
      const finalized = finalizedActivations.get(record.runId);
      if (finalized?.has(record.activationId)) {
        return { accepted: false, reason: "late-activation" };
      }
      const effect =
        record.status === "running" ? (existing.started ? "update" : "start") : "complete";
      existing.lastSequence = record.sequence;
      existing.status = record.status;
      existing.started = true;
      if (record.status !== "running") {
        rememberFinalized(record.runId, record.activationId);
        runs.delete(record.runId);
      }
      return { accepted: true, effect };
    }
    // A different activation for this run: only fresh (never finalized)
    // activations start a new tracked run; events for settled activations
    // are late and rejected.
    if (finalizedActivations.get(record.runId)?.has(record.activationId)) {
      return { accepted: false, reason: "late-activation" };
    }
    if (record.status === "running") {
      if (runs.size >= MAX_TRACKED_RUNS) {
        const oldest = runs.keys().next().value;
        if (oldest !== undefined) runs.delete(oldest);
      }
      runs.set(record.runId, {
        activationId: record.activationId,
        lastSequence: record.sequence,
        status: record.status,
        started: true,
      });
      return { accepted: true, effect: "start" };
    }
    // Terminal event for an activation this bridge never saw running: apply
    // it as a complete so the row does not dangle as a zombie.
    rememberFinalized(record.runId, record.activationId);
    return { accepted: true, effect: "complete" };
  };

  const openRuns = (): ReadonlyArray<{
    readonly runId: string;
    readonly activationId: string;
    readonly status: "running";
  }> =>
    Array.from(runs.entries(), ([runId, state]) => ({
      runId,
      activationId: state.activationId,
      status: "running" as const,
    }));

  const findOpenRun = (runId: string): { activationId: string } | undefined => {
    const state = runs.get(runId);
    return state === undefined ? undefined : { activationId: state.activationId };
  };

  return { apply, openRuns, findOpenRun };
}

export type ManagerRunRegistry = ReturnType<typeof makeManagerRunRegistry>;
