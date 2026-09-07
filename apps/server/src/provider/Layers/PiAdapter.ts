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
  type ChatImageAttachment,
  EventId,
  isProviderSendTurnSupportedImageMimeType,
  type ModelSelection,
  type OrchestrationSubagentControlActionResult,
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
  type SubagentRunEvidence,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  buildPiRpcLaunch,
  buildPiExperimentRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "../piLaunchArgs.ts";
import { withVoiceNotificationsEnv } from "../ProviderInstanceEnvironment.ts";
import { zaiUsageLimitWindows } from "../zaiUsageLimits.ts";
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
  ProviderSubagentBindingResultInput,
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
  drainManagerRunReplay,
  encodeControlEnvelope,
  exchangeManagerRecord,
  makeManagerRunRegistry,
  makeRunBindingTracker,
  type ManagerRecord,
  type ManagerRunBindingTracker,
  type ManagerRunRegistry,
  type ManagerRunUpsert,
  type ManagerTranscriptItem,
  type NegotiatedManagerControl,
  negotiationFromRecord,
} from "../PiSubagentControl.ts";
import { ProjectionSubagentTranscriptStore } from "../../persistence/Services/ProjectionSubagentTranscripts.ts";

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

const PiAssistantMessageEnd = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
});
const decodePiAssistantMessageEnd = Schema.decodeUnknownOption(PiAssistantMessageEnd);

const PiAssistantTextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const decodePiAssistantTextBlock = Schema.decodeUnknownOption(PiAssistantTextBlock);

interface ManagedPiSubagent {
  readonly taskId: RuntimeTaskId;
  readonly nativeRunId: string;
  readonly activationId: string;
  readonly startedAt: string;
  readonly title: string;
  readonly harness: "pi" | "claude" | "codex";
  readonly model?: string;
  readonly toolUseId: string;
  readonly parentAgentId?: RuntimeTaskId;
}

interface OpenManagerRun {
  readonly nativeRunId: string;
  readonly activationId: string;
  readonly startedAt: string;
  readonly title?: string;
  readonly harness: string;
  readonly model?: string;
  /** Present only on an enhanced-manager allocating start with binding evidence. */
  readonly runBirth?: string;
  readonly upsertSequence?: number;
}

interface PendingPiSubagentTerminal {
  readonly status: "done" | "error";
  readonly content: string;
}

/** assistant/reasoning streaming items keyed by `messageId:contentIndex`. */
type StreamItemsMap = Map<
  string,
  {
    itemId: string;
    kind: StreamItemKind;
    contentIndex: number;
    started: boolean;
    hasContent: boolean;
  }
>;

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
  /** Raw manager id → opaque T3 run. */
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
  /** Bounded Phase 1.5 binding tuples (open and terminal) for this session. */
  runBindings: ManagerRunBindingTracker;
  /** Namespaced T3 task id → open manager run (steer/cancel lookup). */
  readonly managerRuns: Map<RuntimeTaskId, OpenManagerRun>;
  /** Correlated manager records awaiting a reply, by envelope id. */
  readonly pendingManagerRecords: Map<string, Deferred.Deferred<ManagerRecord>>;
  /** Restore upserts can arrive before the negotiation entry activates the registry. */
  readonly pendingManagerRunUpserts: ManagerRunUpsert[];
  managerNegotiating: boolean;
  nativeSessionPath: string | undefined;
  /** Item id of the compaction currently reported by Pi, if any. */
  activeCompactionItemId: string | undefined;
}

export interface PiAdapterOptions {
  readonly instanceId?: ProviderSession["providerInstanceId"];
  readonly environment?: NodeJS.ProcessEnv;
}

const SETTLE_PROBE_TIMEOUT_MS = 2_000;
const SETTLE_PROBE_RETRY_DELAY_MILLIS = 100;
const SETTLE_PROBE_MAX_ATTEMPTS = 3;
/** Manual compaction runs an LLM summary call; it can legitimately take minutes. */
const COMPACT_REQUEST_TIMEOUT_MS = 5 * 60_000;
const MANAGED_SUBAGENT_SUMMARY_MAX_CODE_POINTS = 4_096;
const MAX_PENDING_MANAGED_TERMINALS = 64;
/**
 * The manager command is only ever sent after `get_commands` proved it is
 * registered, so a present-but-unresponsive manager is the only slow path;
 * an absent manager costs the session nothing.
 */
const MANAGER_NEGOTIATION_TIMEOUT_MS = 5_000;
const MANAGER_CONTROL_ACK_TIMEOUT_MS = 10_000;
const MAX_PENDING_MANAGER_RUN_UPSERTS = 64;

type PiRpcImageContent = Readonly<{
  type: "image";
  data: string;
  mimeType: string;
}>;

const readPiRpcImage = Effect.fn("readPiRpcImage")(function* (
  attachment: ChatImageAttachment,
  dependencies: {
    readonly attachmentsDir: string;
    readonly fileSystem: FileSystem.FileSystem;
  },
) {
  if (!isProviderSendTurnSupportedImageMimeType(attachment.mimeType)) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "prompt",
      detail: `Unsupported Pi image attachment type '${attachment.mimeType}'.`,
    });
  }

  const attachmentPath = resolveAttachmentPath({
    attachmentsDir: dependencies.attachmentsDir,
    attachment,
  });
  if (attachmentPath === null) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "prompt",
      detail: `Invalid attachment id '${attachment.id}'.`,
    });
  }

  const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "prompt",
          detail: "Failed to read attachment file.",
          cause,
        }),
    ),
  );
  return {
    type: "image",
    data: Buffer.from(bytes).toString("base64"),
    mimeType: attachment.mimeType,
  } satisfies PiRpcImageContent;
});

function buildPiPromptRecord(input: {
  readonly message: string;
  readonly images: ReadonlyArray<PiRpcImageContent>;
  readonly streamingBehavior?: "steer";
}) {
  return {
    type: "prompt",
    message: input.message,
    ...(input.images.length > 0 ? { images: input.images } : {}),
    ...(input.streamingBehavior === undefined
      ? {}
      : { streamingBehavior: input.streamingBehavior }),
  } satisfies PiRpcRecord;
}

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
    const fileSystem = yield* FileSystem.FileSystem;
    // Optional shared side-store sink. Absent means this build did not wire
    // the Phase 1.5 transcript store: the negotiated capability stays off
    // and every manager stays summary-only — the stock-Pi behavior.
    const transcriptSinkOption = yield* Effect.serviceOption(ProjectionSubagentTranscriptStore);
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

    /**
     * Pi surfaces no usage limits of its own, so GLM sessions read z.ai's
     * quota endpoint directly. Non-z.ai models and empty results emit nothing.
     */
    const emitZaiUsageLimits = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.session.model?.startsWith("zai/") !== true) return;
        const windows = yield* zaiUsageLimitWindows;
        if (windows.length === 0) return;
        const base = yield* makeEventBase(ctx.session);
        yield* offerRuntimeEvent({
          ...base,
          type: "account.rate-limits.updated",
          payload: { limits: { windows } },
        });
      });

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

    /**
     * Open a new active turn and emit `turn.started`. Shared by sendTurn
     * (T3-initiated) and the `agent_start` pump case (extension-initiated,
     * e.g. a subagents follow-up delivered while the thread was idle).
     */
    const openTurn = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      options: { readonly mayBeCommandOnly: boolean; readonly sawAgentActivity: boolean },
    ) {
      const turnId = TurnId.make(yield* nextUuid);
      const turn: ActivePiTurn = {
        turnId,
        interrupted: false,
        sawAgentActivity: options.sawAgentActivity,
        mayBeCommandOnly: options.mayBeCommandOnly,
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
      return turn;
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
        } else {
          yield* offerRuntimeEvent({
            ...base,
            type: "turn.completed",
            turnId: turn.turnId,
            payload: { state: interrupted ? "interrupted" : "completed" },
          });
        }
        yield* emitZaiUsageLimits(ctx);
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

    const newSubagentRunId = nextUuid.pipe(Effect.map(RuntimeTaskId.make));

    const managedSubagentLinkage = (
      ctx: PiSessionContext,
      run: ManagedPiSubagent,
      status: SubagentRunEvidence["status"],
      terminalReason?: SubagentRunEvidence["terminalReason"],
    ) => ({
      taskType: "subagent" as const,
      title: run.title,
      // The Pi manager has no separate role concept; harness is its best available role value.
      role: run.harness,
      ...(run.model !== undefined ? { model: run.model } : {}),
      toolUseId: run.toolUseId,
      ...(run.parentAgentId !== undefined ? { parentAgentId: run.parentAgentId } : {}),
      runHandles: { runId: run.taskId },
      timelineBypass: true,
      subagentRun: {
        runId: run.taskId,
        // Only ever a currently-known T3 run of this owner epoch; a native
        // parent id with no live T3 mapping is omitted, never forged.
        ...(run.parentAgentId !== undefined ? { parentRunId: run.parentAgentId } : {}),
        runtimeFamily: "pi-stock",
        harness: run.harness,
        provider: PROVIDER,
        ...(boundInstanceId !== undefined ? { providerInstanceId: boundInstanceId } : {}),
        ownerEpoch: ctx.processEpoch,
        nativeRunId: run.nativeRunId,
        activationId: run.activationId,
        status,
        ...(terminalReason !== undefined ? { terminalReason } : {}),
        controlAvailability: "unsupported",
        historyAvailability: "summary-only",
        capabilities: { steer: false, cancel: false, resume: false },
        startedAt: run.startedAt,
      } satisfies SubagentRunEvidence,
    });

    const completeManagedSubagent = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      nativeId: string,
      status: "completed" | "failed" | "stopped",
      content?: string,
      stopReason: "owner-lost" | "owner-replaced" = "owner-lost",
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
      const inventoryStatus =
        status === "completed" ? "done" : status === "failed" ? "error" : "interrupted";
      const terminalReason =
        status === "completed"
          ? "native-completed"
          : status === "failed"
            ? "native-error"
            : stopReason;
      const base = yield* makeEventBase(ctx.session);
      yield* offerRuntimeEvent({
        ...base,
        type: "task.completed",
        payload: {
          taskId: run.taskId,
          status,
          ...(summary !== undefined ? { summary } : {}),
          ...managedSubagentLinkage(ctx, run, inventoryStatus, terminalReason),
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
      const [taskId, base] = yield* Effect.all([newSubagentRunId, makeEventBase(ctx.session)]);
      const parentAgentId =
        details.parent_id === undefined
          ? undefined
          : ctx.managedSubagents.get(details.parent_id)?.taskId;
      const run: ManagedPiSubagent = {
        taskId,
        nativeRunId: details.id,
        activationId: toolUseId,
        startedAt: base.createdAt,
        title: details.title,
        harness: details.harness,
        ...(details.model !== undefined ? { model: details.model } : {}),
        toolUseId,
        ...(parentAgentId !== undefined ? { parentAgentId } : {}),
      };
      ctx.managedSubagents.set(details.id, run);
      yield* offerRuntimeEvent({
        ...base,
        type: "task.started",
        turnId: turn.turnId,
        payload: {
          taskId: run.taskId,
          description: run.title,
          ...managedSubagentLinkage(ctx, run, "active"),
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
      /** Durable per-run watermarks for reconnect replay, when known. */
      readonly replay?: ReadonlyArray<{ readonly runId: string; readonly watermark: number }>;
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
                // T3's additive Phase 1.5 offer: active only when the
                // manager's negotiation record declares it too.
                ...(transcriptSinkOption._tag === "Some"
                  ? { capabilities: { childTranscripts: true as const } }
                  : {}),
                ...(input.replay !== undefined && input.replay.length > 0
                  ? { replay: input.replay }
                  : {}),
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

    const findManagerRun = (ctx: PiSessionContext, nativeRunId: string, activationId: string) => {
      for (const entry of ctx.managerRuns) {
        if (entry[1].nativeRunId === nativeRunId && entry[1].activationId === activationId) {
          return entry;
        }
      }
      return undefined;
    };

    const managerTaskLinkage = (
      ctx: PiSessionContext,
      taskId: RuntimeTaskId,
      run: OpenManagerRun,
      status: SubagentRunEvidence["status"],
      terminalReason?: SubagentRunEvidence["terminalReason"],
    ) => {
      const control = ctx.managerControl;
      const controls =
        control === null
          ? { steer: { enabled: false }, cancel: { enabled: false } }
          : deriveControlAvailabilities(control.capabilities);
      const ownerRouted = controls.steer.enabled || controls.cancel.enabled;
      const transcriptCapable =
        control?.capabilities.childTranscripts === true &&
        run.runBirth !== undefined &&
        transcriptSinkOption._tag === "Some";
      return {
        taskType: "subagent" as const,
        ...(run.title !== undefined ? { title: run.title } : {}),
        role: run.harness,
        ...(run.model !== undefined ? { model: run.model } : {}),
        runHandles: { runId: taskId },
        timelineBypass: true,
        subagentRun: {
          runId: taskId,
          runtimeFamily: "pi-manager",
          harness: run.harness,
          provider: PROVIDER,
          ...(boundInstanceId !== undefined ? { providerInstanceId: boundInstanceId } : {}),
          ...(control !== null ? { ownerId: control.managerId } : {}),
          ownerEpoch: ctx.processEpoch,
          nativeRunId: run.nativeRunId,
          activationId: run.activationId,
          // Phase 1.5 binding evidence rides only when both sides activated
          // child transcripts; malformed capability-absent upserts remain
          // summary-only and cannot trigger a binding-result route.
          ...(transcriptCapable && run.runBirth !== undefined ? { runBirth: run.runBirth } : {}),
          ...(transcriptCapable && run.upsertSequence !== undefined
            ? { upsertSequence: run.upsertSequence }
            : {}),
          status,
          ...(terminalReason !== undefined ? { terminalReason } : {}),
          controlAvailability:
            status === "queued" || status === "active" || status === "cancelling"
              ? ownerRouted
                ? "owner-routed"
                : "unsupported"
              : ownerRouted
                ? "read-only"
                : "unsupported",
          historyAvailability: transcriptCapable ? "durable" : "summary-only",
          capabilities: {
            steer: control?.capabilities.steering ?? false,
            cancel: control?.capabilities.cancellation ?? false,
            resume: false,
          },
          startedAt: run.startedAt,
        } satisfies SubagentRunEvidence,
      };
    };

    const settleManagerRun = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      nativeRunId: string,
      activationId: string,
      reason: "owner-lost" | "owner-replaced",
    ) {
      const entry = findManagerRun(ctx, nativeRunId, activationId);
      if (entry === undefined) return;
      const [taskId, run] = entry;
      ctx.managerRuns.delete(taskId);
      const base = yield* makeEventBase(ctx.session);
      yield* offerRuntimeEvent({
        ...base,
        type: "task.completed",
        payload: {
          taskId,
          status: "stopped",
          ...managerTaskLinkage(ctx, taskId, run, "interrupted", reason),
        },
      });
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
      if (applied.effect === "start") {
        if (applied.superseded !== undefined) {
          yield* settleManagerRun(ctx, record.runId, applied.superseded, "owner-replaced");
        }
        if (applied.evicted !== undefined) {
          yield* settleManagerRun(
            ctx,
            applied.evicted.runId,
            applied.evicted.activationId,
            "owner-lost",
          ).pipe(Effect.ignore);
        }
        const [taskId, base] = yield* Effect.all([newSubagentRunId, makeEventBase(ctx.session)]);
        const run: OpenManagerRun = {
          nativeRunId: record.runId,
          activationId: record.activationId,
          startedAt: base.createdAt,
          ...(record.title !== undefined ? { title: record.title } : {}),
          harness: record.harness ?? "pi",
          ...(record.model !== undefined ? { model: record.model } : {}),
          ...(record.runBirth !== undefined ? { runBirth: record.runBirth } : {}),
          ...(record.upsertSequence !== undefined ? { upsertSequence: record.upsertSequence } : {}),
        };
        ctx.managerRuns.set(taskId, run);
        // Phase 1.5: an allocating start that carried binding evidence under
        // an active childTranscripts negotiation installs the binding tuple
        // the run-upsert-result and later transcript items validate against.
        if (
          record.runBirth !== undefined &&
          record.upsertSequence !== undefined &&
          ctx.managerControl?.capabilities.childTranscripts === true &&
          transcriptSinkOption._tag === "Some"
        ) {
          const installed = ctx.runBindings.install({
            managerId: ctx.managerControl.managerId,
            nativeRunId: record.runId,
            activationId: record.activationId,
            runBirth: record.runBirth,
            upsertSequence: record.upsertSequence,
            t3RunId: taskId,
          });
          if (!installed.ok) {
            yield* Effect.logDebug("Rejected conflicting Pi subagent run binding.", {
              nativeRunId: record.runId,
              conflict: installed.conflict,
            });
          }
        }
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId,
            ...(run.title !== undefined ? { description: run.title } : {}),
            ...managerTaskLinkage(ctx, taskId, run, "active"),
          },
        });
        return;
      }

      const entry = findManagerRun(ctx, record.runId, record.activationId);
      if (entry === undefined) {
        yield* Effect.logDebug("Ignored Pi subagent manager event without an owned live run.", {
          runId: record.runId,
          activationId: record.activationId,
        });
        return;
      }
      const [taskId, existingRun] = entry;
      const run: OpenManagerRun = {
        ...existingRun,
        ...(record.title !== undefined ? { title: record.title } : {}),
        ...(record.harness !== undefined ? { harness: record.harness } : {}),
        ...(record.model !== undefined ? { model: record.model } : {}),
      };
      if (applied.effect === "update") {
        ctx.managerRuns.set(taskId, run);
        const base = yield* makeEventBase(ctx.session);
        yield* offerRuntimeEvent({
          ...base,
          type: "task.updated",
          payload: {
            taskId,
            status: "running",
            ...managerTaskLinkage(ctx, taskId, run, "active"),
          },
        });
        return;
      }

      ctx.managerRuns.delete(taskId);
      const base = yield* makeEventBase(ctx.session);
      const status =
        record.status === "done" ? "done" : record.status === "error" ? "error" : "cancelled";
      const terminalReason =
        record.status === "done"
          ? "native-completed"
          : record.status === "error"
            ? "native-error"
            : "native-cancelled";
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
          ...managerTaskLinkage(ctx, taskId, run, status, terminalReason),
        },
      });
    });

    /**
     * Validate one finalized transcript record as a five-member binding unit
     * and, only then, hand it to the shared side-store writer. Terminal-late
     * items follow the same path: acceptance may advance the watermark but
     * never reopens lifecycle. No transcript body ever enters a runtime event.
     */
    const applyManagerTranscriptItem = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      record: ManagerTranscriptItem,
    ) {
      if (ctx.managerControl?.capabilities.childTranscripts !== true) return;
      if (transcriptSinkOption._tag !== "Some") return;
      if (ctx.managerControl.managerId !== record.managerId) return;
      const observedAt = yield* nowIso;
      const ingested = yield* transcriptSinkOption.value.ingestItem({
        runId: RuntimeTaskId.make(record.t3RunId),
        managerId: record.managerId,
        managerRunId: record.runId,
        activationId: record.activationId,
        runBirth: record.runBirth,
        item: {
          kind: record.item.kind,
          transcriptSequence: record.transcriptSequence,
          text: record.item.text,
          truncated: record.item.truncated,
          upstreamTruncated: record.item.upstreamTruncated,
          createdAt: record.item.createdAt ?? null,
        },
        observedAt,
      });
      if (ingested.outcome === "rejected-binding") {
        yield* Effect.logDebug("Rejected Pi subagent transcript item binding.", {
          runId: record.t3RunId,
          transcriptSequence: record.transcriptSequence,
        });
      }
    });

    const handleManagerRecord = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      value: unknown,
    ) {
      const record = decodeManagerRecord(value);
      if (record === undefined) return;
      if (record.kind === "run-upsert") {
        if (ctx.managerNegotiating) {
          if (ctx.pendingManagerRunUpserts.length >= MAX_PENDING_MANAGER_RUN_UPSERTS) {
            ctx.pendingManagerRunUpserts.shift();
          }
          ctx.pendingManagerRunUpserts.push(record);
          return;
        }
        yield* applyManagerRunUpsert(ctx, record);
        return;
      }
      if (record.kind === "transcript-item") {
        yield* applyManagerTranscriptItem(ctx, record);
        return;
      }
      // Negotiation and ack records resolve their awaited correlation.
      const pending = ctx.pendingManagerRecords.get(record.id);
      if (pending === undefined) return;
      ctx.pendingManagerRecords.delete(record.id);
      yield* Deferred.succeed(pending, record).pipe(Effect.asVoid);
    });

    const handleEntryAppended = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      event: PiRpcRecord,
    ) {
      yield* handleManagedSubagentResult(ctx, event);
      const entry = recordField(event, "entry");
      if (
        recordString(entry, "type") !== "custom" ||
        recordString(entry, "customType") !== MANAGER_RECORD_TYPE
      ) {
        return;
      }
      yield* handleManagerRecord(ctx, recordField(entry, "data"));
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
      // A protocol match keeps status supported. Individual controls still
      // require normalized lifecycle events and their routing capability.
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

    /**
     * Durable replay watermarks for every binding owned by this manager in
     * the current thread, including terminal and zero-watermark runs.
     */
    const replayWatermarksFor = (
      ctx: PiSessionContext,
      managerId: string | undefined = ctx.managerControl?.managerId,
    ): Effect.Effect<ReadonlyArray<{ readonly runId: string; readonly watermark: number }>> =>
      transcriptSinkOption._tag === "Some" && managerId !== undefined
        ? transcriptSinkOption.value
            .readWatermarksForManager({ threadId: ctx.threadId, managerId })
            .pipe(
              Effect.map((entries) =>
                entries.map((entry) => ({
                  runId: String(entry.runId),
                  watermark: entry.watermark,
                })),
              ),
              Effect.catchCause(() => Effect.succeed([])),
            )
        : Effect.succeed([]);

    const refreshManagerControl = (ctx: PiSessionContext, expectedManagerId: string) =>
      Effect.gen(function* () {
        const commandsData = yield* ctx.connection.request({ type: "get_commands" }).pipe(
          Effect.mapError(
            () =>
              new SubagentControlError({
                reason: "manager-unreachable",
                detail: "Could not refresh Pi's registered extension commands.",
              }),
          ),
        );
        const extensionCommandNames = new Set(
          parsePiDiscoveredCommands(commandsData).extensionCommandNames,
        );
        if (!extensionCommandNames.has(SUBAGENT_MANAGER_COMMAND)) {
          return yield* new SubagentControlError({
            reason: "unsupported",
            detail: `Pi subagent manager command '/${SUBAGENT_MANAGER_COMMAND}' is not registered in this Pi process.`,
          });
        }
        const negotiation = yield* negotiateManagerControl({
          threadId: ctx.threadId,
          connection: ctx.connection,
          extensionCommandNames,
          pendingManagerRecords: ctx.pendingManagerRecords,
          replay: yield* replayWatermarksFor(ctx),
        }).pipe(
          Effect.mapError(
            () =>
              new SubagentControlError({
                reason: "manager-unreachable",
                detail: "Could not refresh Pi subagent manager capabilities.",
              }),
          ),
        );
        if (negotiation.control === null) {
          return yield* new SubagentControlError({
            reason: negotiation.reason?.includes("timed out") ? "timeout" : "unsupported",
            ...(negotiation.reason !== undefined ? { detail: negotiation.reason } : {}),
          });
        }
        if (negotiation.control.managerId !== expectedManagerId) {
          return yield* new SubagentControlError({
            reason: "manager-mismatch",
            detail: `Pi now declares subagent manager '${negotiation.control.managerId}', not '${expectedManagerId}'.`,
          });
        }
        ctx.managerControl = negotiation.control;
        ctx.managerReason = undefined;
        return negotiation.control;
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

    /**
     * Deliver one exact `run-upsert-result` to the live manager that owns the
     * binding. Identical redelivery after a lost ack resolves from the
     * tracker without another envelope; a conflicting tuple fails truthfully.
     */
    const deliverManagerBindingResult = (
      input: ProviderSubagentBindingResultInput,
    ): Effect.Effect<
      OrchestrationSubagentControlActionResult,
      ProviderAdapterError | SubagentControlError
    > =>
      Effect.gen(function* () {
        let ownerSession: PiSessionContext | undefined;
        for (const ctx of sessions.values()) {
          if (ctx.managerControl?.managerId !== input.managerId) continue;
          ownerSession = ctx;
          const tuple = ctx.runBindings.findByT3RunId(String(input.runId));
          if (tuple === undefined) {
            return yield* new SubagentControlError({
              reason: "unknown-run",
              detail: `Manager '${input.managerId}' does not track a binding for run '${input.runId}'.`,
            });
          }
          if (
            tuple.nativeRunId !== input.nativeRunId ||
            tuple.activationId !== input.activationId ||
            tuple.runBirth !== input.runBirth ||
            tuple.upsertSequence !== input.upsertSequence
          ) {
            return yield* new SubagentControlError({
              reason: "manager-mismatch",
              detail: "The binding result does not match the installed run binding tuple.",
            });
          }
          if (ctx.runBindings.isAcked(String(input.runId))) {
            return { accepted: true } as const;
          }
          const control = yield* refreshManagerControl(ctx, ctx.managerControl.managerId);
          if (control.capabilities.childTranscripts !== true) {
            return yield* new SubagentControlError({
              reason: "control-disabled",
              detail: "Pi subagent manager does not declare the childTranscripts capability.",
            });
          }
          const correlationId = yield* nextUuid;
          yield* sendManagerControlCommand(ctx, {
            v: MANAGER_PROTOCOL_VERSION,
            op: "run-upsert-result",
            id: correlationId,
            managerId: control.managerId,
            runId: tuple.nativeRunId,
            activationId: tuple.activationId,
            runBirth: tuple.runBirth,
            upsertSequence: tuple.upsertSequence,
            t3RunId: String(input.runId),
          });
          ctx.runBindings.markAcked(String(input.runId));
          return { accepted: true } as const;
        }
        return yield* new SubagentControlError({
          reason: ownerSession === undefined ? "unknown-manager" : "unknown-run",
          ...(ownerSession === undefined
            ? {
                detail: `This adapter does not declare subagent manager '${input.managerId}'.`,
              }
            : {}),
        });
      });

    const steerManagerRun = (input: OrchestrationSubagentControlSteerInput) =>
      Effect.gen(function* () {
        const target = yield* requireManagerRun(input.managerId, input.runId);
        const snapshot = target.ctx.managerControl;
        if (snapshot === null) {
          return yield* new SubagentControlError({
            reason: "unsupported",
            ...(target.ctx.managerReason !== undefined ? { detail: target.ctx.managerReason } : {}),
          });
        }
        const control = yield* refreshManagerControl(target.ctx, snapshot.managerId);
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
        const snapshot = target.ctx.managerControl;
        if (snapshot === null) {
          return yield* new SubagentControlError({
            reason: "unsupported",
            ...(target.ctx.managerReason !== undefined ? { detail: target.ctx.managerReason } : {}),
          });
        }
        const control = yield* refreshManagerControl(target.ctx, snapshot.managerId);
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
                if (turn !== null) {
                  turn.sawAgentActivity = true;
                  return;
                }
                // No T3 sendTurn in flight: an extension (e.g. subagents
                // delivering a settled follow-up) started this agent run on
                // its own. Open a turn so the reply is not dropped.
                yield* openTurn(ctx, { mayBeCommandOnly: false, sawAgentActivity: true });
                return;
              }
              case "compaction_start": {
                // Manual and automatic compactions report the same lifecycle.
                // T3 observes only; the summary text stays inside Pi.
                const itemId = `compaction:${yield* nextUuid}`;
                ctx.activeCompactionItemId = itemId;
                const base = yield* makeEventBase(ctx.session);
                yield* offerRuntimeEvent({
                  ...base,
                  type: "item.started",
                  ...(turn !== null ? { turnId: turn.turnId } : {}),
                  itemId: RuntimeItemId.make(itemId),
                  payload: {
                    itemType: "context_compaction",
                    status: "inProgress",
                    title: "Context compaction",
                  },
                });
                return;
              }
              case "compaction_end": {
                const itemId = ctx.activeCompactionItemId;
                ctx.activeCompactionItemId = undefined;
                const aborted = recordField(event, "aborted") === true;
                const errorMessage = recordString(event, "errorMessage");
                const succeeded = !aborted && errorMessage === undefined;
                if (itemId !== undefined) {
                  const base = yield* makeEventBase(ctx.session);
                  yield* offerRuntimeEvent({
                    ...base,
                    type: "item.completed",
                    ...(turn !== null ? { turnId: turn.turnId } : {}),
                    itemId: RuntimeItemId.make(itemId),
                    payload: {
                      itemType: "context_compaction",
                      status: succeeded ? "completed" : aborted ? "declined" : "failed",
                      title: "Context compaction",
                    },
                  });
                }
                if (succeeded) {
                  // The single canonical compaction observation: ingestion
                  // turns this into the "Context compacted" activity.
                  const base = yield* makeEventBase(ctx.session);
                  yield* offerRuntimeEvent({
                    ...base,
                    type: "thread.state.changed",
                    payload: {
                      state: "compacted",
                      detail: { reason: recordString(event, "reason") ?? "manual" },
                    },
                  });
                }
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
                  item = {
                    itemId: `msg:${key}`,
                    kind,
                    contentIndex,
                    started: false,
                    hasContent: false,
                  };
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
                const text = recordString(delta, "delta") ?? "";
                if (text.length > 0) item.hasContent = true;
                yield* emitContentDelta({
                  ctx,
                  turn,
                  streamKind: kind === "assistant_message" ? "assistant_text" : "reasoning_text",
                  delta: text,
                  contentIndex,
                  nativeItemId: item.itemId,
                });
                return;
              }
              case "message_end": {
                if (turn === null) return;
                const decoded = decodePiAssistantMessageEnd(event["message"]);
                if (Option.isNone(decoded)) return;
                const message = decoded.value;
                const streamedTextItems = new Map(
                  [...ctx.streamItems.values()]
                    .filter((item) => item.kind === "assistant_message")
                    .map((item) => [item.contentIndex, item]),
                );
                for (const [contentIndex, block] of (message.content ?? []).entries()) {
                  const decodedBlock = decodePiAssistantTextBlock(block);
                  if (Option.isNone(decodedBlock) || decodedBlock.value.text.length === 0) continue;
                  const text = decodedBlock.value.text;
                  let item = streamedTextItems.get(contentIndex);
                  if (item?.hasContent === true) continue;
                  if (item === undefined) {
                    const key = `${yield* nextUuid}:${contentIndex}`;
                    item = {
                      itemId: `msg:${key}`,
                      kind: "assistant_message",
                      contentIndex,
                      started: false,
                      hasContent: false,
                    };
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
                  item.hasContent = true;
                  yield* emitContentDelta({
                    ctx,
                    turn,
                    streamKind: "assistant_text",
                    delta: text,
                    contentIndex,
                    nativeItemId: item.itemId,
                  });
                }
                yield* resolveSettledStreamItems(ctx, turn);
                if (message.stopReason === "error" && turn.failure === null) {
                  turn.failure = {
                    message: message.errorMessage ?? "Pi reported a model error.",
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
                yield* handleEntryAppended(ctx, event);
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
        for (const [taskId, run] of ctx.managerRuns) {
          const base = yield* makeEventBase(ctx.session);
          yield* offerRuntimeEvent({
            ...base,
            type: "task.completed",
            payload: {
              taskId,
              status: "stopped",
              ...managerTaskLinkage(ctx, taskId, run, "interrupted", "owner-lost"),
            },
          });
        }
        ctx.managerRuns.clear();
        ctx.runBindings = makeRunBindingTracker();
        ctx.pendingManagerRunUpserts.length = 0;
        ctx.managerNegotiating = false;
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
        const candidateMcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const mcpSession =
          candidateMcpSession !== undefined &&
          (boundInstanceId === undefined ||
            candidateMcpSession.providerInstanceId === boundInstanceId)
            ? candidateMcpSession
            : undefined;
        const isExperiment = mcpSession?.experiment !== undefined;
        const resolvedLaunchArgs = isExperiment
          ? ({ ok: true, args: [] } as const)
          : resolvePiLaunchArgs(piSettings.launchArgs);
        if (!resolvedLaunchArgs.ok) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: resolvedLaunchArgs.message,
          });
        }
        const extensionPath = yield* materializePiT3McpExtension(
          serverConfig.providerStatusCacheDir,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError((cause) => adapterError(input.threadId, "materialize_t3_mcp", cause)),
        );
        const launch =
          isExperiment && mcpSession !== undefined
            ? buildPiExperimentRpcLaunch({ environment, extensionPath, mcpSession })
            : buildPiRpcLaunch({
                launchArgs: resolvedLaunchArgs.args,
                environment,
                extensionPath,
                runtimeMode: input.runtimeMode,
                ...(mcpSession === undefined ? {} : { mcpSession }),
              });
        const scope = yield* Scope.make("sequential");
        return yield* Effect.gen(function* () {
          const connection = yield* makePiRpcConnection({
            command: piSettings.binaryPath || "pi",
            args: launch.args,
            cwd: input.cwd ?? serverConfig.cwd,
            env: withVoiceNotificationsEnv(launch.env, input.voiceNotifications),
          }).pipe(
            Effect.mapError((cause) => adapterError(input.threadId, "spawn", cause)),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(Scope.Scope, scope),
          );
          const resume = isExperiment ? undefined : parseResumeCursor(input.resumeCursor);
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
            runBindings: makeRunBindingTracker(),
            managerRuns: new Map(),
            pendingManagerRecords,
            pendingManagerRunUpserts: [],
            managerNegotiating: true,
            nativeSessionPath,
            activeCompactionItemId: undefined,
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
          if (ctx.managerControl?.capabilities.childTranscripts === true) {
            const replayManagerId = ctx.managerControl.managerId;
            const replay = yield* replayWatermarksFor(ctx, replayManagerId);
            if (replay.length > 0) {
              const replayNegotiation = yield* negotiateManagerControl({
                threadId: input.threadId,
                connection,
                extensionCommandNames,
                pendingManagerRecords,
                replay,
              });
              if (
                replayNegotiation.control !== null &&
                replayNegotiation.control.managerId === replayManagerId
              ) {
                ctx.managerControl = replayNegotiation.control;
                ctx.managerReason = replayNegotiation.reason;
              } else {
                ctx.managerControl = null;
                ctx.managerReason =
                  replayNegotiation.reason ??
                  "Pi subagent manager identity changed during replay negotiation.";
              }
            }
          }
          ctx.managerRegistry = makeManagerRunRegistry(ctx.managerControl?.managerId ?? "");
          if (ctx.managerControl === null) {
            ctx.pendingManagerRunUpserts.length = 0;
            ctx.managerNegotiating = false;
          } else {
            yield* drainManagerRunReplay(ctx, (record) => applyManagerRunUpsert(ctx, record));
          }
          const base = yield* makeEventBase(session);
          yield* offerRuntimeEvent({
            ...base,
            type: "session.started",
            payload: resume !== undefined ? { resume: encodeResumeCursor(nativeSessionPath) } : {},
          });
          yield* emitZaiUsageLimits(ctx);
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
        // Pi RPC accepts images as native ImageContent. Generic files stay out
        // of this array and reach Pi through the path lines ProviderService
        // appends to the prompt.
        const images = yield* Effect.forEach(
          (input.attachments ?? []).filter(
            (attachment): attachment is ChatImageAttachment => attachment.type === "image",
          ),
          (attachment) =>
            readPiRpcImage(attachment, {
              attachmentsDir: serverConfig.attachmentsDir,
              fileSystem,
            }),
          { concurrency: 1 },
        );
        // A sendTurn while a turn is active is a steer: the message queues on
        // Pi's side and lands inside the active run. No new turn starts.
        const activeTurn = ctx.activeTurn;
        if (activeTurn !== null) {
          yield* ctx.connection
            .send(buildPiPromptRecord({ message: promptText, images, streamingBehavior: "steer" }))
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
        const commandName = input.input.trimStart().match(/^\/([^\s]+)/)?.[1];
        const turn = yield* openTurn(ctx, {
          mayBeCommandOnly: commandName !== undefined && ctx.extensionCommandNames.has(commandName),
          sawAgentActivity: false,
        });
        const turnId = turn.turnId;
        // Fire-and-forget: Pi acks `prompt` only after slash-command
        // expansion completes, and extension commands may block on user
        // dialogs indefinitely. Rejections arrive later as id-less response
        // records handled by the event pump.
        yield* ctx.connection
          .send(buildPiPromptRecord({ message: promptText, images }))
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

    /**
     * Provider-native manual compaction: send Pi's `compact` RPC and let the
     * event pump report the lifecycle. The response data (summary text, token
     * estimates) is deliberately discarded — T3 never stores a summary.
     */
    const compactContext = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // Compacting mid-turn would abort the run; the idle-only rule is
        // enforced here so every caller is protected.
        if (ctx.activeTurn !== null) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "compactContext",
            detail: "Pi compaction cannot start while a turn is running.",
          });
        }
        if (ctx.activeCompactionItemId !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "compactContext",
            detail: "A Pi compaction is already in progress for this thread.",
          });
        }
        // The transport fails the request on `success: false` (carrying
        // Pi's error), so reaching here means compaction ran to completion.
        // The response data — summary text and token estimates — is dropped.
        yield* ctx.connection
          .request({ type: "compact" }, COMPACT_REQUEST_TIMEOUT_MS)
          .pipe(Effect.mapError((cause) => adapterError(threadId, "compact", cause)));
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
      bindingResult: deliverManagerBindingResult,
    } satisfies ProviderSubagentControlPlaneShape<ProviderAdapterError>;

    yield* Effect.addFinalizer(() => Effect.ignore(stopAll()));

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      compaction: { type: "native", start: compactContext },
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
