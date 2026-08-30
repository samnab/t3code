/**
 * PiAdapter — current-architecture `ProviderAdapterShape` for the Pi coding
 * agent, driving `pi --mode rpc` over stdio JSONL via `piRpc.ts`.
 *
 * Source: behavior extracted from upstream T3 PR #7211
 * (`apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts`, head
 * `a00565fbfc34a5fefd1222e1868f41e36cb02378`, MIT, author StiensWout) and
 * reworked onto `ProviderAdapterShape` instead of the orchestration-v2
 * engine — see `docs/fork/upstream-pr-ledger.md`.
 *
 * Design intent: honor the user's Pi customizations. The process is spawned
 * with no `--no-*` flags, so the user's extensions, skills, prompt templates,
 * AGENTS.md / SYSTEM.md context, settings.json, custom models, and auth all
 * load exactly as they do in the `pi` TUI. Sessions are stored by Pi itself
 * (default `~/.pi/agent/sessions/`), and the session file path is the durable
 * native identity carried in `resumeCursor`, so a thread started in T3 can
 * be resumed from the TUI and vice versa.
 *
 * Turn lifecycle: `agent_settled` is the only terminal signal. `agent_end`
 * merely closes one low-level run — compaction retries, auto-retries, and
 * queued continuations may still follow it, so the turn stays open until Pi
 * reports the session settled. A command-only prompt (pure extension slash
 * command) never starts an agent run, so it settles through an idle
 * `get_state` probe instead.
 *
 * Extension UI: Pi extensions raise dialogs through `extension_ui_request`.
 * Confirm dialogs map to approval requests, select/input/editor to user
 * input; answers travel back as `extension_ui_response`. Terminal-only
 * decoration (status, widget, title, editor text) has no T3 surface and is
 * ignored.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type ModelSelection,
  type PiSettings,
  ProviderDriverKind,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  SubagentControlError,
  type OrchestrationSubagentControlCancelInput,
  type OrchestrationSubagentControlSteerInput,
  type SubagentControlPlaneStatus,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildPiRpcLaunch, resolvePiLaunchArgs } from "../piLaunchArgs.ts";
import { expandPiSkillReference, parsePiDiscoveredCommands } from "../PiCommands.ts";
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../piRpc.ts";
import type {
  ProviderAdapterShape,
  ProviderSubagentControlPlaneShape,
  ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import {
  MANAGER_PROTOCOL_VERSION,
  MANAGER_RECORD_TYPE,
  SUBAGENT_MANAGER_COMMAND,
  type ControlEnvelope,
  decodeManagerRecord,
  deriveControlAvailabilities,
  encodeControlEnvelope,
  exchangeManagerRecord,
  makeManagerRunRegistry,
  type ManagerRecord,
  type ManagerRunRegistry,
  type ManagerRunUpsert,
  type NegotiatedManagerControl,
  negotiationFromRecord,
} from "../PiSubagentControl.ts";

const PROVIDER = ProviderDriverKind.make("pi");

/**
 * Versioned native resume state. `sessionPath` is Pi's own session file path
 * from `get_state` (`sessionFile`), or its `sessionId` when no file path is
 * reported. Opaque to the rest of T3; only this adapter decodes it.
 */
const PI_RESUME_VERSION = 1 as const;

type StreamItemKind = "assistant_message" | "reasoning";
type ToolItemKind = "command_execution" | "dynamic_tool_call";

const PiSubagentId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const PiSubagentTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const PiSubagentLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const PiSubagentStatus = Schema.Literals(["running", "done", "error"]);

const PiSubagentSpawnDetails = Schema.Struct({
  id: PiSubagentId,
  title: PiSubagentTitle,
  cwd: Schema.String,
  harness: Schema.Literals(["pi", "claude", "codex"]),
  model: Schema.optional(PiSubagentLabel),
  status: PiSubagentStatus,
  parent_id: Schema.optional(PiSubagentId),
  trusted_suborch: Schema.Boolean,
});
const decodePiSubagentSpawnDetails = Schema.decodeUnknownOption(PiSubagentSpawnDetails);

const PiSubagentResultEntry = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.Literal("subagent-result"),
  data: Schema.Struct({
    id: PiSubagentId,
    title: PiSubagentTitle,
    status: Schema.Literals(["done", "error"]),
    content: Schema.String,
  }),
});
const decodePiSubagentResultEntry = Schema.decodeUnknownOption(PiSubagentResultEntry);

const PiSubagentToolResults = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      id: PiSubagentId,
      title: Schema.optional(PiSubagentTitle),
      status: Schema.optional(PiSubagentStatus),
      collection: Schema.optional(Schema.Literals(["still-running", "collected"])),
    }),
  ),
});
const decodePiSubagentToolResults = Schema.decodeUnknownOption(PiSubagentToolResults);

interface ManagedPiSubagent {
  readonly taskId: RuntimeTaskId;
  readonly title: string;
  readonly harness: "pi" | "claude" | "codex";
  readonly model?: string;
  readonly toolUseId: string;
  readonly parentAgentId?: string;
}

interface PendingPiSubagentTerminal {
  readonly status: "done" | "error";
  readonly content: string;
}

/** assistant/reasoning streaming items keyed by `messageId:contentIndex`. */
type StreamItemsMap = Map<string, { itemId: string; kind: StreamItemKind; started: boolean }>;

interface PiResumeCursor {
  readonly sessionPath: string;
}

function encodeResumeCursor(sessionPath: string): unknown {
  return { schemaVersion: PI_RESUME_VERSION, sessionPath };
}

function parseResumeCursor(raw: unknown): PiResumeCursor | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== PI_RESUME_VERSION) return undefined;
  if (typeof record.sessionPath !== "string" || record.sessionPath.trim().length === 0) {
    return undefined;
  }
  return { sessionPath: record.sessionPath };
}

interface ActivePiTurn {
  readonly turnId: TurnId;
  interrupted: boolean;
  /**
   * Whether any agent run activity was observed. Command-only prompts (pure
   * extension slash commands) never start an agent run and never emit
   * `agent_settled`; an idle probe settles the turn instead.
   */
  sawAgentActivity: boolean;
  /** Only discovered extension commands can complete without starting an agent run. */
  readonly mayBeCommandOnly: boolean;
  /** Invalidates idle snapshots when new work starts after a settle probe. */
  settleProbeGeneration: number;
  failure: { readonly message: string } | null;
}

interface PendingPiExtensionUi {
  readonly nativeRequestId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly requestId: RuntimeRequestId;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly connection: PiRpcConnection;
  readonly pumpFiber: Fiber.Fiber<void, never>;
  /** Skill names discovered from the live session; `$name` chips hoist to them. */
  readonly skillNames: ReadonlySet<string>;
  /** Extension commands are the only slash commands that bypass agent processing. */
  readonly extensionCommandNames: ReadonlySet<string>;
  readonly streamItems: StreamItemsMap;
  session: ProviderSession;
  activeTurn: ActivePiTurn | null;
  readonly pendingExtensionUi: Map<ApprovalRequestId, PendingPiExtensionUi>;
  /** Unique to this spawned Pi process; native manager ids reset to sa-1. */
  readonly processEpoch: string;
  /** Raw manager id → namespaced T3 run. */
  readonly managedSubagents: Map<string, ManagedPiSubagent>;
  readonly pendingManagedSpawnToolCalls: Set<string>;
  readonly pendingManagedTerminals: Map<string, PendingPiSubagentTerminal>;
  /**
   * Negotiated subagent manager control plane, or null when the manager
   * command is absent, negotiation failed, or the protocol mismatches. When
   * non-null the manager's normalized events are authoritative and the
   * tool-result projection is suppressed. Assigned after registration: the
   * event pump routes manager records through this session map entry.
   */
  managerControl: NegotiatedManagerControl | null;
  /** Explicit unsupported/mismatch reason when `managerControl` is null. */
  managerReason: string | undefined;
  /** Idempotent run-upsert state machine for the negotiated manager. */
  managerRegistry: ManagerRunRegistry;
  /** Namespaced T3 task id → open manager run (steer/cancel lookup). */
  readonly managerRuns: Map<
    RuntimeTaskId,
    { readonly nativeRunId: string; readonly activationId: string }
  >;
  /** Correlated manager records awaiting a reply, by envelope id. */
  readonly pendingManagerRecords: Map<string, Deferred.Deferred<ManagerRecord>>;
  nativeSessionPath: string | undefined;
}

export interface PiAdapterOptions {
  readonly instanceId?: ProviderSession["providerInstanceId"];
  readonly environment?: NodeJS.ProcessEnv;
}

const SETTLE_PROBE_TIMEOUT_MS = 2_000;
const SETTLE_PROBE_RETRY_DELAY_MILLIS = 100;
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
const MANAGED_SUBAGENT_SUMMARY_MAX_CODE_POINTS = 4_096;
const MAX_PENDING_MANAGED_TERMINALS = 64;
/**
 * The manager command is only ever sent after `get_commands` proved it is
 * registered, so a present-but-unresponsive manager is the only slow path;
 * an absent manager costs the session nothing.
 */
const MANAGER_NEGOTIATION_TIMEOUT_MS = 5_000;
const MANAGER_CONTROL_ACK_TIMEOUT_MS = 10_000;
/** Mirrors the canonical manager's 50-run cap; routing state never outgrows it. */
const MAX_OPEN_MANAGER_RUNS = 50;

function truncateCodePoints(value: string, limit: number) {
  let codePoints = 0;
  let end = 0;
  for (const codePoint of value) {
    if (codePoints >= limit) break;
    codePoints += 1;
    end += codePoint.length;
  }
  return value.slice(0, end);
}

export function makePiAdapter(piSettings: PiSettings, options?: PiAdapterOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const serverConfig = yield* Effect.service(ServerConfig);
    const environment = options?.environment ?? process.env;

    const sessions = new Map<ThreadId, PiSessionContext>();
    const runtimeEventPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProviderRuntimeEvent>(),
      PubSub.shutdown,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextUuid = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Pi runtime identifier.",
            cause,
          }),
      ),
    );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const makeEventBase = (session: ProviderSession) =>
      Effect.gen(function* () {
        const [eventId, createdAt] = yield* Effect.all([nextUuid, nowIso]);
        return {
          eventId: EventId.make(eventId),
          provider: PROVIDER,
          ...(boundInstanceId !== undefined ? { providerInstanceId: boundInstanceId } : {}),
          threadId: session.threadId,
          createdAt,
        };
      });

    const adapterError = (threadId: ThreadId, operation: string, cause: unknown) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: `Pi ${operation} failed.`,
        cause,
      });

    const requireSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (ctx === undefined) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return ctx;
      });

    const updateSession = (ctx: PiSessionContext, patch: Partial<ProviderSession>) =>
      Effect.gen(function* () {
        ctx.session = { ...ctx.session, ...patch, updatedAt: yield* nowIso };
      });

    // ── event emission ──────────────────────────────────────────

    const emitItem = Effect.fnUntraced(function* (input: {
      readonly ctx: PiSessionContext;
      readonly turn: ActivePiTurn;
      readonly phase: "item.started" | "item.updated" | "item.completed";
      readonly itemType: StreamItemKind | ToolItemKind;
      readonly status: "inProgress" | "completed" | "failed";
      readonly title?: string;
      readonly nativeItemId: string;
    }) {
      const base = yield* makeEventBase(input.ctx.session);
      yield* offerRuntimeEvent({
        ...base,
        type: input.phase,
        turnId: input.turn.turnId,
        itemId: RuntimeItemId.make(input.nativeItemId),
        payload: {
          itemType: input.itemType,
          status: input.status,
          ...(input.title !== undefined && input.title.length > 0 ? { title: input.title } : {}),
        },
      });
    });

    const emitContentDelta = Effect.fnUntraced(function* (input: {
      readonly ctx: PiSessionContext;
      readonly turn: ActivePiTurn;
      readonly streamKind: "assistant_text" | "reasoning_text";
      readonly delta: string;
      readonly contentIndex: number;
      readonly nativeItemId: string;
    }) {
      const base = yield* makeEventBase(input.ctx.session);
      yield* offerRuntimeEvent({
        ...base,
        type: "content.delta",
        turnId: input.turn.turnId,
        itemId: RuntimeItemId.make(input.nativeItemId),
        payload: {
          streamKind: input.streamKind,
          delta: input.delta,
          contentIndex: input.contentIndex,
        },
      });
    });

    // ── turn settlement ─────────────────────────────────────────

    const finalizeTurn = (ctx: PiSessionContext, turn: ActivePiTurn) =>
      Effect.gen(function* () {
        if (ctx.activeTurn !== turn) return;
        ctx.activeTurn = null;
        const interrupted = turn.interrupted;
        const failure = interrupted ? null : turn.failure;
        for (const [, pending] of ctx.pendingExtensionUi) {
          yield* ctx.connection
            .send({
              type: "extension_ui_response",
              id: pending.nativeRequestId,
              cancelled: true,
            })
            .pipe(Effect.ignore);
          const base = yield* makeEventBase(ctx.session);
          yield* offerRuntimeEvent({
            ...base,
            requestId: pending.requestId,
            type: "request.resolved",
            payload: { requestType: "unknown", decision: "cancel" },
          });
        }
        ctx.pendingExtensionUi.clear();
        yield* updateSession(ctx, {
          status: failure !== null ? "error" : "ready",
          activeTurnId: undefined,
          ...(failure !== null ? { lastError: failure.message } : {}),
        });
        const base = yield* makeEventBase(ctx.session);
        if (failure !== null) {
          yield* offerRuntimeEvent({
            ...base,
            type: "turn.completed",
            turnId: turn.turnId,
            payload: { state: "failed", errorMessage: failure.message },
          });
        } else if (interrupted) {
          yield* offerRuntimeEvent({
            ...base,
            type: "turn.aborted",
            turnId: turn.turnId,
            payload: { reason: "interrupted" },
          });
        } else {
          yield* offerRuntimeEvent({
            ...base,
            type: "turn.completed",
            turnId: turn.turnId,
            payload: { state: "completed" },
          });
        }
      });

    /**
     * Command-only prompts (pure extension slash commands) never start an
     * agent run and never emit `agent_settled`, so settle through an idle
     * `get_state` probe. The probe re-checks the turn's settle generation so
     * new work always wins over a stale idle snapshot.
     */
    const scheduleSettleProbe = (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
      settleAfterAgentActivity: boolean,
      attempt = 1,
    ): Effect.Effect<void> => {
      const generation = turn.settleProbeGeneration;
      return ctx.connection.request({ type: "get_state" }, SETTLE_PROBE_TIMEOUT_MS).pipe(
        Effect.flatMap((data) =>
          Effect.gen(function* () {
            if (
              ctx.activeTurn !== turn ||
              turn.settleProbeGeneration !== generation ||
              (!settleAfterAgentActivity && turn.sawAgentActivity)
            ) {
              return;
            }
            if (
              recordField(data, "isStreaming") !== true &&
              recordField(data, "isCompacting") !== true &&
              (recordNumber(data, "pendingMessageCount") ?? 0) === 0
            ) {
              yield* finalizeTurn(ctx, turn);
            }
          }),
        ),
        Effect.catchCause(() =>
          Effect.gen(function* () {
            if (ctx.activeTurn !== turn || turn.settleProbeGeneration !== generation) return;
            if (attempt < SETTLE_PROBE_MAX_ATTEMPTS) {
              yield* Effect.sleep(SETTLE_PROBE_RETRY_DELAY_MILLIS).pipe(
                Effect.andThen(
                  scheduleSettleProbe(ctx, turn, settleAfterAgentActivity, attempt + 1),
                ),
              );
              return;
            }
            // Pi is wedged after repeated probe failures; tear the transport
            // down so the pump fails the turn instead of leaving it live.
            yield* ctx.connection.terminate;
          }),
        ),
        Effect.ignore,
      );
    };

    // ── event pump ──────────────────────────────────────────────

    const toolItemTitle = (event: PiRpcRecord): string => {
      const toolName = recordString(event, "toolName") ?? "tool";
      const args = recordField(event, "args");
      const title =
        recordString(args, "command") ?? recordString(args, "path") ?? recordString(args, "url");
      return title === undefined ? toolName : `${toolName}: ${title}`;
    };

    const namespacedManagedSubagentId = (ctx: PiSessionContext, nativeId: string) =>
      RuntimeTaskId.make(`pi:${ctx.processEpoch}:${nativeId}`);

    const managedSubagentLinkage = (run: ManagedPiSubagent) => ({
      taskType: "subagent" as const,
      title: run.title,
      // The Pi manager has no separate role concept; harness is its best available role value.
      role: run.harness,
      ...(run.model !== undefined ? { model: run.model } : {}),
      toolUseId: run.toolUseId,
      ...(run.parentAgentId !== undefined ? { parentAgentId: run.parentAgentId } : {}),
      runHandles: { runId: run.taskId },
      timelineBypass: true,
    });

    const completeManagedSubagent = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      nativeId: string,
      status: "completed" | "failed" | "stopped",
      content?: string,
    ) {
      const run = ctx.managedSubagents.get(nativeId);
      if (run === undefined) return false;
      ctx.managedSubagents.delete(nativeId);
      ctx.pendingManagedTerminals.delete(nativeId);
      const summary =
        content === undefined
          ? undefined
          : truncateCodePoints(content, MANAGED_SUBAGENT_SUMMARY_MAX_CODE_POINTS).trim() ||
            `${run.title} ${status}`;
      const base = yield* makeEventBase(ctx.session);
      yield* offerRuntimeEvent({
        ...base,
        type: "task.completed",
        payload: {
          taskId: run.taskId,
          status,
          ...(summary !== undefined ? { summary } : {}),
          ...managedSubagentLinkage(run),
        },
      });
      return true;
    });

    const rememberPendingManagedTerminal = (
      ctx: PiSessionContext,
      nativeId: string,
      terminal: PendingPiSubagentTerminal,
    ) => {
      if (
        ctx.pendingManagedSpawnToolCalls.size === 0 ||
        ctx.pendingManagedTerminals.has(nativeId)
      ) {
        return;
      }
      if (ctx.pendingManagedTerminals.size >= MAX_PENDING_MANAGED_TERMINALS) {
        const oldest = ctx.pendingManagedTerminals.keys().next().value;
        if (oldest !== undefined) ctx.pendingManagedTerminals.delete(oldest);
      }
      ctx.pendingManagedTerminals.set(nativeId, terminal);
    };

    const handleManagedSubagentSpawn = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
      event: PiRpcRecord,
    ) {
      // Suppressed only while the manager's normalized events own the
      // lifecycle; with the capability absent this projection is authoritative.
      if (managerLifecycleActive(ctx)) return;
      if (recordString(event, "toolName") !== "subagent_spawn" || event["isError"] === true) {
        return;
      }
      const result = recordField(event, "result");
      const decoded = decodePiSubagentSpawnDetails(recordField(result, "details"));
      if (Option.isNone(decoded)) return;
      const details = decoded.value;
      if (ctx.managedSubagents.has(details.id)) return;
      const toolUseId = recordString(event, "toolCallId");
      if (toolUseId === undefined) return;
      const run: ManagedPiSubagent = {
        taskId: namespacedManagedSubagentId(ctx, details.id),
        title: details.title,
        harness: details.harness,
        ...(details.model !== undefined ? { model: details.model } : {}),
        toolUseId,
        ...(details.parent_id !== undefined
          ? { parentAgentId: namespacedManagedSubagentId(ctx, details.parent_id) }
          : {}),
      };
      ctx.managedSubagents.set(details.id, run);
      const base = yield* makeEventBase(ctx.session);
      yield* offerRuntimeEvent({
        ...base,
        type: "task.started",
        turnId: turn.turnId,
        payload: {
          taskId: run.taskId,
          description: run.title,
          ...managedSubagentLinkage(run),
        },
      });
      const pending = ctx.pendingManagedTerminals.get(details.id);
      if (pending !== undefined) {
        yield* completeManagedSubagent(
          ctx,
          details.id,
          pending.status === "done" ? "completed" : "failed",
          pending.content,
        );
      } else if (details.status !== "running") {
        yield* completeManagedSubagent(
          ctx,
          details.id,
          details.status === "done" ? "completed" : "failed",
        );
      }
    });

    const handleManagedSubagentResult = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      event: PiRpcRecord,
    ) {
      // Summary fallback only: suppressed while manager events are normalized.
      if (managerLifecycleActive(ctx)) return;
      const decoded = decodePiSubagentResultEntry(recordField(event, "entry"));
      if (Option.isNone(decoded)) return;
      const data = decoded.value.data;
      if (ctx.managedSubagents.has(data.id)) {
        yield* completeManagedSubagent(
          ctx,
          data.id,
          data.status === "done" ? "completed" : "failed",
          data.content,
        );
        return;
      }
      rememberPendingManagedTerminal(ctx, data.id, {
        status: data.status,
        content: truncateCodePoints(data.content, MANAGED_SUBAGENT_SUMMARY_MAX_CODE_POINTS),
      });
    });

    const handleManagedSubagentToolResult = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      event: PiRpcRecord,
    ) {
      // Summary fallback only: suppressed while manager events are normalized.
      if (managerLifecycleActive(ctx)) return;
      const toolName = recordString(event, "toolName");
      if (
        event["isError"] === true ||
        (toolName !== "subagent_wait" && toolName !== "subagent_cancel")
      ) {
        return;
      }
      const result = recordField(event, "result");
      const decoded = decodePiSubagentToolResults(recordField(result, "details"));
      if (Option.isNone(decoded)) return;
      for (const terminal of decoded.value.results) {
        if (
          terminal.status === undefined ||
          terminal.status === "running" ||
          (toolName === "subagent_wait" && terminal.collection !== "collected")
        ) {
          continue;
        }
        yield* completeManagedSubagent(
          ctx,
          terminal.id,
          terminal.status === "done" ? "completed" : "failed",
        );
      }
    });

    // ── subagent manager control plane ─────────────────

    /**
     * The manager's normalized events own the subagent lifecycle only when
     * the manager declared that capability; otherwise the pre-existing
     * tool-result projection keeps running and manager upserts are ignored.
     */
    const managerLifecycleActive = (ctx: PiSessionContext) =>
      ctx.managerControl?.capabilities.normalizedEvents === true;

    /**
     * Negotiate the subagent manager once per native process, after
     * `get_commands` proved the command is registered. An absent command
     * never sends a prompt (it would reach the model) and resolves to an
     * explicit unsupported status instead.
     */
    const negotiateManagerControl = (input: {
      readonly threadId: ThreadId;
      readonly connection: PiRpcConnection;
      readonly extensionCommandNames: ReadonlySet<string>;
      readonly pendingManagerRecords: Map<string, Deferred.Deferred<ManagerRecord>>;
    }) =>
      Effect.gen(function* () {
        if (!input.extensionCommandNames.has(SUBAGENT_MANAGER_COMMAND)) {
          return {
            control: null,
            reason: `Pi subagent manager command '/${SUBAGENT_MANAGER_COMMAND}' is not registered in this Pi process; subagent controls stay read-only.`,
          };
        }
        const correlationId = yield* nextUuid;
        // The correlation is armed before the prompt leaves the process, so a
        // synchronous manager reply can never miss its Deferred.
        const record = yield* exchangeManagerRecord(
          input.pendingManagerRecords,
          correlationId,
          MANAGER_NEGOTIATION_TIMEOUT_MS,
          input.connection
            .send({
              type: "prompt",
              message: `/${SUBAGENT_MANAGER_COMMAND} ${encodeControlEnvelope({
                v: MANAGER_PROTOCOL_VERSION,
                op: "negotiate",
                id: correlationId,
              })}`,
            })
            .pipe(
              Effect.mapError((cause) => adapterError(input.threadId, "subagent negotiate", cause)),
            ),
        );
        if (record === undefined) {
          return { control: null, reason: "Pi subagent manager negotiation timed out." };
        }
        if (record.kind !== "negotiation") {
          return {
            control: null,
            reason: "Pi subagent manager sent an unexpected negotiation reply.",
          };
        }
        const parsed = negotiationFromRecord(record);
        return parsed.ok ? { control: parsed.control } : { control: null, reason: parsed.reason };
      });

    const managerTaskId = (ctx: PiSessionContext, activationId: string, nativeRunId: string) =>
      RuntimeTaskId.make(`pi:${ctx.processEpoch}:${activationId}:${nativeRunId}`);

    const managerTaskLinkage = (record: ManagerRunUpsert, taskId: RuntimeTaskId) => ({
      taskType: "subagent" as const,
      ...(record.title !== undefined ? { title: record.title } : {}),
      role: record.harness ?? "pi",
      ...(record.model !== undefined ? { model: record.model } : {}),
      runHandles: { runId: taskId },
      timelineBypass: true,
    });

    const applyManagerRunUpsert = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      record: ManagerRunUpsert,
    ) {
      if (!managerLifecycleActive(ctx)) return;
      const applied = ctx.managerRegistry.apply(record);
      if (!applied.accepted) {
        yield* Effect.logDebug("Rejected Pi subagent manager run event.", {
          reason: applied.reason,
          runId: record.runId,
        });
        return;
      }
      const taskId = managerTaskId(ctx, record.activationId, record.runId);
      const base = yield* makeEventBase(ctx.session);
      if (applied.effect === "start") {
        // A replacement activation must settle the old row first, or the
        // prior activation's task stays running forever.
        if (applied.superseded !== undefined) {
          const supersededTaskId = managerTaskId(ctx, applied.superseded, record.runId);
          ctx.managerRuns.delete(supersededTaskId);
          const supersededBase = yield* makeEventBase(ctx.session);
          yield* offerRuntimeEvent({
            ...supersededBase,
            type: "task.completed",
            payload: { taskId: supersededTaskId, status: "stopped" },
          });
        }
        if (ctx.managerRuns.size >= MAX_OPEN_MANAGER_RUNS) {
          const oldest = ctx.managerRuns.keys().next().value;
          if (oldest !== undefined) ctx.managerRuns.delete(oldest);
        }
        ctx.managerRuns.set(taskId, {
          nativeRunId: record.runId,
          activationId: record.activationId,
        });
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId,
            ...(record.title !== undefined ? { description: record.title } : {}),
            ...managerTaskLinkage(record, taskId),
          },
        });
        return;
      }
      if (applied.effect === "update") {
        yield* offerRuntimeEvent({
          ...base,
          type: "task.updated",
          payload: { taskId, status: "running", ...managerTaskLinkage(record, taskId) },
        });
        return;
      }
      ctx.managerRuns.delete(taskId);
      yield* offerRuntimeEvent({
        ...base,
        type: "task.completed",
        payload: {
          taskId,
          status:
            record.status === "done"
              ? "completed"
              : record.status === "error"
                ? "failed"
                : "stopped",
          ...(record.summary !== undefined && record.summary.trim().length > 0
            ? { summary: record.summary }
            : {}),
          ...managerTaskLinkage(record, taskId),
        },
      });
    });

    const handleManagerRecord = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      event: PiRpcRecord,
    ) {
      const record = decodeManagerRecord(event);
      if (record === undefined) return;
      if (record.kind === "run-upsert") {
        yield* applyManagerRunUpsert(ctx, record);
        return;
      }
      // Negotiation and ack records resolve their awaited correlation.
      const pending = ctx.pendingManagerRecords.get(record.id);
      if (pending === undefined) return;
      ctx.pendingManagerRecords.delete(record.id);
      yield* Deferred.succeed(pending, record).pipe(Effect.asVoid);
    });

    const buildControlPlaneStatus = (ctx: PiSessionContext): SubagentControlPlaneStatus => {
      const control = ctx.managerControl;
      if (control === null) {
        const reason = ctx.managerReason ?? "Pi subagent manager is unavailable.";
        return {
          provider: PROVIDER,
          threadId: ctx.threadId,
          supported: false,
          reason,
          controls: {
            steer: { enabled: false, reason },
            cancel: { enabled: false, reason },
          },
        };
      }
      // A negotiated manager is supported whenever its protocol matched;
      // normalizedEvents only decides which source owns the lifecycle.
      // Steer/cancel derive independently from the declared capabilities.
      const controls = deriveControlAvailabilities(control.capabilities);
      return {
        provider: PROVIDER,
        threadId: ctx.threadId,
        supported: true,
        managerId: control.managerId,
        protocolVersion: control.protocolVersion,
        capabilities: control.capabilities,
        controls: { steer: controls.steer, cancel: controls.cancel },
      };
    };

    /**
     * Resolve the session and open run that a manager-owned control targets.
     * Ownership is by declared manager id: a session whose negotiation named
     * a different manager is never used.
     */
    const requireManagerRun = (managerId: string, runId: RuntimeTaskId) =>
      Effect.gen(function* () {
        let ownerSession: PiSessionContext | undefined;
        for (const ctx of sessions.values()) {
          if (ctx.managerControl?.managerId !== managerId) continue;
          ownerSession = ctx;
          const run = ctx.managerRuns.get(runId);
          if (run !== undefined) return { ctx, run };
        }
        if (ownerSession === undefined) {
          return yield* new SubagentControlError({
            reason: "manager-mismatch",
            detail: `This adapter does not declare subagent manager '${managerId}'.`,
          });
        }
        return yield* new SubagentControlError({
          reason: "unknown-run",
          detail: `Manager '${managerId}' does not track an open run '${runId}'.`,
        });
      });

    const sendManagerControlCommand = (ctx: PiSessionContext, envelope: ControlEnvelope) =>
      Effect.gen(function* () {
        // Arm the correlation before sending, mirroring negotiation: a fast
        // manager ack must never miss its Deferred.
        const record = yield* exchangeManagerRecord(
          ctx.pendingManagerRecords,
          envelope.id,
          MANAGER_CONTROL_ACK_TIMEOUT_MS,
          ctx.connection
            .send({
              type: "prompt",
              message: `/${SUBAGENT_MANAGER_COMMAND} ${encodeControlEnvelope(envelope)}`,
            })
            .pipe(
              Effect.mapError(() => new SubagentControlError({ reason: "manager-unreachable" })),
            ),
        );
        if (record === undefined) {
          return yield* new SubagentControlError({ reason: "timeout" });
        }
        if (record.kind !== "ack") {
          return yield* new SubagentControlError({
            reason: "manager-rejected",
            detail: "Manager replied with a non-acknowledgement record.",
          });
        }
        if (!record.accepted) {
          return yield* new SubagentControlError({
            reason: "manager-rejected",
            ...(record.error !== undefined ? { detail: record.error } : {}),
          });
        }
      });

    const steerManagerRun = (input: OrchestrationSubagentControlSteerInput) =>
      Effect.gen(function* () {
        const target = yield* requireManagerRun(input.managerId, input.runId);
        const control = target.ctx.managerControl;
        if (control === null) {
          return yield* new SubagentControlError({ reason: "unsupported" });
        }
        const controls = deriveControlAvailabilities(control.capabilities);
        if (!controls.steer.enabled) {
          return yield* new SubagentControlError({
            reason: "control-disabled",
            ...(controls.steer.reason !== undefined ? { detail: controls.steer.reason } : {}),
          });
        }
        const correlationId = yield* nextUuid;
        yield* sendManagerControlCommand(target.ctx, {
          v: MANAGER_PROTOCOL_VERSION,
          op: "steer",
          id: correlationId,
          managerId: control.managerId,
          runId: target.run.nativeRunId,
          activationId: target.run.activationId,
          text: input.text,
        });
        return { accepted: true } as const;
      });

    const cancelManagerRun = (input: OrchestrationSubagentControlCancelInput) =>
      Effect.gen(function* () {
        const target = yield* requireManagerRun(input.managerId, input.runId);
        const control = target.ctx.managerControl;
        if (control === null) {
          return yield* new SubagentControlError({ reason: "unsupported" });
        }
        const controls = deriveControlAvailabilities(control.capabilities);
        if (!controls.cancel.enabled) {
          return yield* new SubagentControlError({
            reason: "control-disabled",
            ...(controls.cancel.reason !== undefined ? { detail: controls.cancel.reason } : {}),
          });
        }
        const correlationId = yield* nextUuid;
        yield* sendManagerControlCommand(target.ctx, {
          v: MANAGER_PROTOCOL_VERSION,
          op: "cancel",
          id: correlationId,
          managerId: control.managerId,
          runId: target.run.nativeRunId,
          activationId: target.run.activationId,
        });
        return { accepted: true } as const;
      });

    const handleToolEvent = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
      event: PiRpcRecord,
      phase: "start" | "update" | "end",
    ) {
      turn.sawAgentActivity = true;
      const toolCallId = recordString(event, "toolCallId");
      if (toolCallId === undefined) return;
      const itemType: ToolItemKind =
        recordString(event, "toolName") === "bash" ? "command_execution" : "dynamic_tool_call";
      const title = toolItemTitle(event);
      const nativeItemId = `tool:${toolCallId}`;
      if (phase === "end") {
        yield* emitItem({
          ctx,
          turn,
          phase: "item.completed",
          itemType,
          status: "completed",
          title,
          nativeItemId,
        });
        return;
      }
      yield* emitItem({
        ctx,
        turn,
        phase: phase === "start" ? "item.started" : "item.updated",
        itemType,
        status: "inProgress",
        title,
        nativeItemId,
      });
    });

    const handleExtensionUiRequest = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      event: PiRpcRecord,
    ) {
      const nativeRequestId = recordString(event, "id");
      const method = recordString(event, "method");
      if (
        nativeRequestId === undefined ||
        (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor")
      ) {
        return;
      }
      const requestId = RuntimeRequestId.make(yield* nextUuid);
      ctx.pendingExtensionUi.set(ApprovalRequestId.make(requestId), {
        nativeRequestId,
        method,
        requestId,
      });
      const base = yield* makeEventBase(ctx.session);
      if (method === "confirm") {
        const detail = recordString(event, "message");
        yield* offerRuntimeEvent({
          ...base,
          requestId,
          type: "request.opened",
          payload: {
            requestType: "exec_command_approval",
            ...(detail !== undefined ? { detail } : {}),
          },
        });
        return;
      }
      const rawOptions = recordField(event, "options");
      const options =
        method === "select" && Array.isArray(rawOptions)
          ? rawOptions
              .filter(
                (option): option is string =>
                  typeof option === "string" && option.trim().length > 0,
              )
              .map((option) => ({ label: option, description: option }))
          : [];
      yield* offerRuntimeEvent({
        ...base,
        requestId,
        type: "user-input.requested",
        payload: {
          questions: [
            {
              id: requestId,
              header: method,
              question:
                recordString(event, "title") ??
                recordString(event, "message") ??
                "Pi extension input requested.",
              options,
            },
          ],
        },
      });
    });

    const resolveSettledStreamItems = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
    ) {
      for (const [, item] of ctx.streamItems) {
        if (item.started) {
          yield* emitItem({
            ctx,
            turn,
            phase: "item.completed",
            itemType: item.kind,
            status: "completed",
            nativeItemId: item.itemId,
          });
        }
      }
      ctx.streamItems.clear();
    });

    /**
     * Pump Pi's session events into adapter runtime events. The session
     * context is looked up per event so the pump never captures a partially
     * constructed session; a removed (stopped) session stops the pump.
     */
    const pumpEvents = (input: {
      readonly threadId: ThreadId;
      readonly connection: PiRpcConnection;
    }): Effect.Effect<void> =>
      Stream.fromQueue(input.connection.events).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const ctx = sessions.get(input.threadId);
            if (ctx === undefined) return;
            const turn = ctx.activeTurn;
            switch (recordString(event, "type") ?? "") {
              case "agent_start": {
                if (turn !== null) turn.sawAgentActivity = true;
                return;
              }
              case "message_update": {
                if (turn === null) return;
                turn.sawAgentActivity = true;
                const delta = event["assistantMessageEvent"];
                const deltaType = recordString(delta, "type");
                const contentIndex = recordNumber(delta, "contentIndex") ?? 0;
                if (deltaType !== "text_delta" && deltaType !== "thinking_delta") return;
                const kind: StreamItemKind =
                  deltaType === "text_delta" ? "assistant_message" : "reasoning";
                const messageId = recordString(delta, "messageId");
                if (messageId === undefined) return;
                const key = `${messageId}:${contentIndex}`;
                let item = ctx.streamItems.get(key);
                if (item === undefined) {
                  item = { itemId: `msg:${key}`, kind, started: false };
                  ctx.streamItems.set(key, item);
                }
                if (!item.started) {
                  item.started = true;
                  yield* emitItem({
                    ctx,
                    turn,
                    phase: "item.started",
                    itemType: item.kind,
                    status: "inProgress",
                    nativeItemId: item.itemId,
                  });
                }
                yield* emitContentDelta({
                  ctx,
                  turn,
                  streamKind: kind === "assistant_message" ? "assistant_text" : "reasoning_text",
                  delta: recordString(delta, "delta") ?? "",
                  contentIndex,
                  nativeItemId: item.itemId,
                });
                return;
              }
              case "message_end": {
                if (turn === null) return;
                const message = event["message"];
                if (recordString(message, "role") !== "assistant") return;
                yield* resolveSettledStreamItems(ctx, turn);
                if (recordString(message, "stopReason") === "error" && turn.failure === null) {
                  turn.failure = {
                    message: recordString(message, "errorMessage") ?? "Pi reported a model error.",
                  };
                }
                return;
              }
              case "tool_execution_start": {
                const toolCallId = recordString(event, "toolCallId");
                if (
                  toolCallId !== undefined &&
                  recordString(event, "toolName") === "subagent_spawn"
                ) {
                  ctx.pendingManagedSpawnToolCalls.add(toolCallId);
                }
                if (turn !== null) yield* handleToolEvent(ctx, turn, event, "start");
                return;
              }
              case "tool_execution_update":
                if (turn !== null) yield* handleToolEvent(ctx, turn, event, "update");
                return;
              case "tool_execution_end": {
                const toolCallId = recordString(event, "toolCallId");
                if (turn !== null) yield* handleToolEvent(ctx, turn, event, "end");
                if (recordString(event, "toolName") === "subagent_spawn") {
                  yield* (
                    turn === null ? Effect.void : handleManagedSubagentSpawn(ctx, turn, event)
                  ).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (toolCallId !== undefined) {
                          ctx.pendingManagedSpawnToolCalls.delete(toolCallId);
                        }
                      }),
                    ),
                  );
                }
                yield* handleManagedSubagentToolResult(ctx, event);
                return;
              }
              case "entry_appended":
                yield* handleManagedSubagentResult(ctx, event);
                return;
              case MANAGER_RECORD_TYPE:
                yield* handleManagerRecord(ctx, event);
                return;
              case "extension_ui_request":
                yield* handleExtensionUiRequest(ctx, event);
                return;
              case "agent_settled": {
                if (turn === null) return;
                if (turn.interrupted) {
                  yield* finalizeTurn(ctx, turn);
                  return;
                }
                // agent_end does not terminalize: compaction retries and
                // auto-retries may follow. Probe for genuine idleness.
                turn.settleProbeGeneration += 1;
                yield* scheduleSettleProbe(ctx, turn, true);
                return;
              }
              case "response": {
                // Id-less response records are the deferred ack of a
                // fire-and-forget prompt.
                if (
                  turn === null ||
                  typeof event["id"] === "string" ||
                  recordString(event, "command") !== "prompt"
                ) {
                  return;
                }
                if (event["success"] === false) {
                  turn.failure = {
                    message: recordString(event, "error") ?? "Pi rejected the prompt.",
                  };
                  yield* finalizeTurn(ctx, turn);
                  return;
                }
                // Pi emits success only after an extension command handler has
                // returned. An idle snapshot before this ack is not terminal.
                if (event["success"] === true && turn.mayBeCommandOnly) {
                  yield* scheduleSettleProbe(ctx, turn, false).pipe(Effect.forkIn(ctx.scope));
                }
                return;
              }
              default:
                return;
            }
          }).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Pi event pump error.", { cause })),
          ),
        ),
        Effect.catchCause(() =>
          Effect.gen(function* () {
            // Transport down: fail any active turn instead of leaving it live.
            const ctx = sessions.get(input.threadId);
            if (ctx === undefined) return;
            const turn = ctx.activeTurn;
            if (turn !== null) {
              turn.failure = { message: "Pi process exited before the turn settled." };
              yield* finalizeTurn(ctx, turn);
            }
            yield* updateSession(ctx, { status: "closed" });
          }),
        ),
        Effect.ignore,
      );

    // ── session lifecycle ───────────────────────────────────────

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from(ctx.managedSubagents.keys()),
          (nativeId) => completeManagedSubagent(ctx, nativeId, "stopped").pipe(Effect.ignore),
          { discard: true },
        );
        ctx.managedSubagents.clear();
        ctx.pendingManagedSpawnToolCalls.clear();
        ctx.pendingManagedTerminals.clear();
        // Manager-owned runs are not tool results; finalize them explicitly so
        // stopping the owning process never leaves rows running forever.
        if (ctx.managerControl !== null) {
          for (const taskId of ctx.managerRuns.keys()) {
            const base = yield* makeEventBase(ctx.session);
            yield* offerRuntimeEvent({
              ...base,
              type: "task.completed",
              payload: { taskId, status: "stopped" },
            });
          }
        }
        ctx.managerRuns.clear();
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
        }
        yield* Fiber.interrupt(ctx.pumpFiber).pipe(Effect.ignore);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      });

    const startSession = (input: ProviderSessionStartInput) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId);
        if (existing !== undefined) {
          yield* stopSessionInternal(existing);
        }
        const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
        if (!resolvedLaunchArgs.ok) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: resolvedLaunchArgs.message,
          });
        }
        const launch = buildPiRpcLaunch({
          launchArgs: resolvedLaunchArgs.args,
          environment,
        });
        const scope = yield* Scope.make("sequential");
        return yield* Effect.gen(function* () {
          const connection = yield* makePiRpcConnection({
            command: piSettings.binaryPath || "pi",
            args: launch.args,
            cwd: input.cwd ?? serverConfig.cwd,
            env: launch.env,
          }).pipe(
            Effect.mapError((cause) => adapterError(input.threadId, "spawn", cause)),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Scope.Scope, scope),
          );
          const resume = parseResumeCursor(input.resumeCursor);
          if (resume !== undefined) {
            // `switch_session` can be vetoed by a `session_before_switch`
            // extension handler; proceeding would silently adopt whatever
            // session is active and write the wrong thread's turns into it.
            const switchData = yield* connection
              .request({ type: "switch_session", sessionPath: resume.sessionPath })
              .pipe(
                Effect.mapError((cause) => adapterError(input.threadId, "switch_session", cause)),
              );
            if (recordField(switchData, "cancelled") === true) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "switch_session",
                detail: "A Pi extension cancelled the session switch.",
              });
            }
          }
          const stateData = yield* connection
            .request({ type: "get_state" })
            .pipe(Effect.mapError((cause) => adapterError(input.threadId, "get_state", cause)));
          // Skills drive `$name` hoisting; extension command names identify
          // the only prompts that can finish without an agent run.
          const commandsData = yield* connection
            .request({ type: "get_commands" })
            .pipe(Effect.orElseSucceed(() => undefined));
          const discoveredCommands = parsePiDiscoveredCommands(commandsData);
          const skillNames = new Set(discoveredCommands.skills.map((skill) => skill.name));
          const extensionCommandNames = new Set(discoveredCommands.extensionCommandNames);
          const pendingManagerRecords = new Map<string, Deferred.Deferred<ManagerRecord>>();
          const nativeSessionPath =
            recordString(stateData, "sessionFile") ?? recordString(stateData, "sessionId");
          if (nativeSessionPath === undefined) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "get_state",
              detail: "get_state returned neither sessionFile nor sessionId.",
            });
          }
          let model: string | undefined;
          if (input.modelSelection !== undefined) {
            const selectionModel = String(input.modelSelection.model);
            const parsed = selectionModel === "default" ? null : parsePiModelSlug(selectionModel);
            if (parsed !== null) {
              yield* connection
                .request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
                .pipe(Effect.mapError((cause) => adapterError(input.threadId, "set_model", cause)));
              model = selectionModel;
            }
          }
          const [now, processEpoch] = yield* Effect.all([nowIso, nextUuid]);
          const session: ProviderSession = {
            provider: PROVIDER,
            ...(boundInstanceId !== undefined ? { providerInstanceId: boundInstanceId } : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(model !== undefined ? { model } : {}),
            threadId: input.threadId,
            resumeCursor: encodeResumeCursor(nativeSessionPath),
            createdAt: now,
            updatedAt: now,
          };
          const pumpFiber = yield* pumpEvents({
            threadId: input.threadId,
            connection,
          }).pipe(Effect.forkIn(scope));
          const ctx: PiSessionContext = {
            threadId: input.threadId,
            scope,
            connection,
            pumpFiber,
            skillNames,
            extensionCommandNames,
            streamItems: new Map(),
            session,
            activeTurn: null,
            pendingExtensionUi: new Map(),
            processEpoch,
            managedSubagents: new Map(),
            pendingManagedSpawnToolCalls: new Set(),
            pendingManagedTerminals: new Map(),
            managerControl: null,
            managerReason: undefined,
            managerRegistry: makeManagerRunRegistry(""),
            managerRuns: new Map(),
            pendingManagerRecords,
            nativeSessionPath,
          };
          sessions.set(input.threadId, ctx);
          // Negotiate only once the pump can route manager records to this
          // session; the awaited reply is what caches the explicit status.
          const managerNegotiation = yield* negotiateManagerControl({
            threadId: input.threadId,
            connection,
            extensionCommandNames,
            pendingManagerRecords,
          });
          ctx.managerControl = managerNegotiation.control;
          ctx.managerReason = managerNegotiation.reason;
          ctx.managerRegistry = makeManagerRunRegistry(managerNegotiation.control?.managerId ?? "");
          const base = yield* makeEventBase(session);
          yield* offerRuntimeEvent({
            ...base,
            type: "session.started",
            payload: resume !== undefined ? { resume: encodeResumeCursor(nativeSessionPath) } : {},
          });
          return session;
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.gen(function* () {
                  const ctx = sessions.get(input.threadId);
                  if (ctx?.scope === scope) sessions.delete(input.threadId);
                  yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
                }),
          ),
        );
      });

    // ── turns ───────────────────────────────────────────────────

    const applyModelSelection = (ctx: PiSessionContext, modelSelection: ModelSelection) =>
      Effect.gen(function* () {
        const selectionModel = String(modelSelection.model);
        if (selectionModel === ctx.session.model) return;
        // `modelSelection.model` may carry an arbitrary slug (for example a
        // model picked for another driver on this thread); an unusable one is
        // ignored and Pi stays on its configured default model.
        const parsed = selectionModel === "default" ? null : parsePiModelSlug(selectionModel);
        if (parsed === null) return;
        yield* ctx.connection
          .request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
          .pipe(Effect.mapError((cause) => adapterError(ctx.threadId, "set_model", cause)));
        yield* updateSession(ctx, { model: selectionModel });
      });

    const sendTurn = (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (input.input === undefined || input.input.trim().length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Pi turns require non-empty input text.",
          });
        }
        // T3's composer inserts skills as `$name` chips; Pi expands skills
        // only through leading `/skill:name` commands, so hoist them here.
        const promptText = expandPiSkillReference(input.input, ctx.skillNames);
        // A sendTurn while a turn is active is a steer: the message queues on
        // Pi's side and lands inside the active run. No new turn starts.
        const activeTurn = ctx.activeTurn;
        if (activeTurn !== null) {
          yield* ctx.connection
            .send({ type: "prompt", message: promptText, streamingBehavior: "steer" })
            .pipe(Effect.mapError((cause) => adapterError(input.threadId, "steer", cause)));
          activeTurn.settleProbeGeneration += 1;
          return {
            threadId: input.threadId,
            turnId: activeTurn.turnId,
            resumeCursor: encodeResumeCursor(ctx.nativeSessionPath ?? ""),
          } satisfies ProviderTurnStartResult;
        }
        if (input.modelSelection !== undefined) {
          yield* applyModelSelection(ctx, input.modelSelection);
        }
        const turnId = TurnId.make(yield* nextUuid);
        const commandName = input.input.trimStart().match(/^\/([^\s]+)/)?.[1];
        const turn: ActivePiTurn = {
          turnId,
          interrupted: false,
          sawAgentActivity: false,
          mayBeCommandOnly: commandName !== undefined && ctx.extensionCommandNames.has(commandName),
          settleProbeGeneration: 0,
          failure: null,
        };
        ctx.activeTurn = turn;
        ctx.streamItems.clear();
        yield* updateSession(ctx, { status: "running", activeTurnId: turnId });
        const base = yield* makeEventBase(ctx.session);
        yield* offerRuntimeEvent({
          ...base,
          type: "turn.started",
          turnId,
          payload: ctx.session.model !== undefined ? { model: ctx.session.model } : {},
        });
        // Fire-and-forget: Pi acks `prompt` only after slash-command
        // expansion completes, and extension commands may block on user
        // dialogs indefinitely. Rejections arrive later as id-less response
        // records handled by the event pump.
        yield* ctx.connection
          .send({ type: "prompt", message: promptText })
          .pipe(Effect.mapError((cause) => adapterError(input.threadId, "prompt", cause)));
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: encodeResumeCursor(ctx.nativeSessionPath ?? ""),
        } satisfies ProviderTurnStartResult;
      });

    const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const turn = ctx.activeTurn;
        if (turn === null) return;
        if (turnId !== undefined && turn.turnId !== turnId) return;
        turn.interrupted = true;
        yield* ctx.connection.request({ type: "abort" }, 2_000).pipe(
          Effect.mapError((cause) => adapterError(threadId, "abort", cause)),
          Effect.tapError(() => Effect.sync(() => (turn.interrupted = false))),
        );
      });

    const respondToExtensionUi = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      payload: (pending: PendingPiExtensionUi) => PiRpcRecord,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingExtensionUi.get(requestId);
        if (pending === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending Pi extension request: ${requestId}`,
          });
        }
        ctx.pendingExtensionUi.delete(requestId);
        yield* ctx.connection
          .send(payload(pending))
          .pipe(Effect.mapError((cause) => adapterError(threadId, "extension_ui_response", cause)));
        return pending;
      });

    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const pending = yield* respondToExtensionUi(threadId, requestId, (request) => {
          const confirmed =
            decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
          return {
            type: "extension_ui_response",
            id: request.nativeRequestId,
            confirmed,
          };
        });
        const ctx = yield* requireSession(threadId);
        const base = yield* makeEventBase(ctx.session);
        yield* offerRuntimeEvent({
          ...base,
          requestId: pending.requestId,
          type: "request.resolved",
          payload: { requestType: "exec_command_approval", decision },
        });
      });

    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        const pending = yield* respondToExtensionUi(threadId, requestId, (request) => {
          const answer = answers[request.requestId];
          return {
            type: "extension_ui_response",
            id: request.nativeRequestId,
            cancelled: answer === undefined,
            ...(answer !== undefined ? { value: answer } : {}),
          };
        });
        const ctx = yield* requireSession(threadId);
        const base = yield* makeEventBase(ctx.session);
        yield* offerRuntimeEvent({
          ...base,
          requestId: pending.requestId,
          type: "user-input.resolved",
          payload: { answers },
        });
      });

    const readThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        // Native turn snapshots need the bounded get_entries mapping; T3's own
        // event store remains the transcript source until that lands.
        return { threadId, turns: [] } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread = (threadId: ThreadId, _numTurns: number) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "Pi provider-side rollback is not supported yet.",
        });
      });

    const stopSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      });

    const stopAll = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
        discard: true,
      });

    const subagentControlPlane = {
      status: () =>
        Effect.sync(() => Array.from(sessions.values(), (ctx) => buildControlPlaneStatus(ctx))),
      steer: steerManagerRun,
      cancel: cancelManagerRun,
    } satisfies ProviderSubagentControlPlaneShape<ProviderAdapterError>;

    yield* Effect.addFinalizer(() => Effect.ignore(stopAll()));

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session }))),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll,
      subagentControlPlane,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
