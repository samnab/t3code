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
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
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
import {
  makePiRpcConnection,
  parsePiModelSlug,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcConnection,
  type PiRpcRecord,
} from "../piRpc.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");

/**
 * Versioned native resume state. `sessionPath` is Pi's own session file path
 * from `get_state` (`sessionFile`), or its `sessionId` when no file path is
 * reported. Opaque to the rest of T3; only this adapter decodes it.
 */
const PI_RESUME_VERSION = 1 as const;

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
  /** Only slash-command prompts can complete without starting an agent run. */
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
  session: ProviderSession;
  activeTurn: ActivePiTurn | null;
  readonly pendingExtensionUi: Map<ApprovalRequestId, PendingPiExtensionUi>;
  nativeSessionPath: string | undefined;
}

export interface PiAdapterOptions {
  readonly instanceId?: ProviderSession["providerInstanceId"];
  readonly environment?: NodeJS.ProcessEnv;
}

const SETTLE_PROBE_TIMEOUT_MS = 2_000;
const SETTLE_PROBE_RETRY_DELAY_MILLIS = 100;
const SETTLE_PROBE_MAX_ATTEMPTS = 3;

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

    type StreamItemKind = "assistant_message" | "reasoning";
    type ToolItemKind = "command_execution" | "dynamic_tool_call";

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

    /** assistant/reasoning streaming items keyed by `messageId:contentIndex`. */
    const streamItems = new Map<
      string,
      { itemId: string; kind: StreamItemKind; started: boolean }
    >();

    const toolItemTitle = (event: PiRpcRecord): string => {
      const toolName = recordString(event, "toolName") ?? "tool";
      const args = recordField(event, "args");
      const title =
        recordString(args, "command") ?? recordString(args, "path") ?? recordString(args, "url");
      return title === undefined ? toolName : `${toolName}: ${title}`;
    };

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
      yield* offerRuntimeEvent({
        ...base,
        requestId,
        type: "user-input.requested",
        payload: {
          questions: [
            {
              id: requestId,
              header: method,
              question: recordString(event, "message") ?? "Pi extension input requested.",
              options: [],
            },
          ],
        },
      });
    });

    const resolveSettledStreamItems = Effect.fnUntraced(function* (
      ctx: PiSessionContext,
      turn: ActivePiTurn,
    ) {
      for (const [, item] of streamItems) {
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
      streamItems.clear();
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
                let item = streamItems.get(key);
                if (item === undefined) {
                  item = { itemId: `msg:${key}`, kind, started: false };
                  streamItems.set(key, item);
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
              case "tool_execution_start":
                if (turn !== null) yield* handleToolEvent(ctx, turn, event, "start");
                return;
              case "tool_execution_update":
                if (turn !== null) yield* handleToolEvent(ctx, turn, event, "update");
                return;
              case "tool_execution_end":
                if (turn !== null) yield* handleToolEvent(ctx, turn, event, "end");
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
                  event["success"] === false &&
                  turn !== null &&
                  typeof event["id"] !== "string" &&
                  recordString(event, "command") === "prompt"
                ) {
                  turn.failure = {
                    message: recordString(event, "error") ?? "Pi rejected the prompt.",
                  };
                  yield* finalizeTurn(ctx, turn);
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
        const cleanupSpawned = Scope.close(scope, Exit.void).pipe(Effect.ignore);
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
            yield* cleanupSpawned;
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
        const nativeSessionPath =
          recordString(stateData, "sessionFile") ?? recordString(stateData, "sessionId");
        if (nativeSessionPath === undefined) {
          yield* cleanupSpawned;
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
        const now = yield* nowIso;
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
          session,
          activeTurn: null,
          pendingExtensionUi: new Map(),
          nativeSessionPath,
        };
        sessions.set(input.threadId, ctx);
        const base = yield* makeEventBase(session);
        yield* offerRuntimeEvent({
          ...base,
          type: "session.started",
          payload: resume !== undefined ? { resume: encodeResumeCursor(nativeSessionPath) } : {},
        });
        return session;
      });

    // ── turns ───────────────────────────────────────────────────

    const applyModelSelection = (ctx: PiSessionContext, modelSelection: ModelSelection) =>
      Effect.gen(function* () {
        const selectionModel = String(modelSelection.model);
        if (selectionModel === ctx.session.model) return;
        // `modelSelection.model` may carry an arbitrary slug; an unusable one
        // is rejected instead of silently leaving Pi on its default model.
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
        // A sendTurn while a turn is active is a steer: the message queues on
        // Pi's side and lands inside the active run. No new turn starts.
        const activeTurn = ctx.activeTurn;
        if (activeTurn !== null) {
          yield* ctx.connection
            .send({ type: "prompt", message: input.input, streamingBehavior: "steer" })
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
        const turn: ActivePiTurn = {
          turnId,
          interrupted: false,
          sawAgentActivity: false,
          mayBeCommandOnly: input.input.trimStart().startsWith("/"),
          settleProbeGeneration: 0,
          failure: null,
        };
        ctx.activeTurn = turn;
        streamItems.clear();
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
          .send({ type: "prompt", message: input.input })
          .pipe(Effect.mapError((cause) => adapterError(input.threadId, "prompt", cause)));
        // A command-only prompt may never emit agent events; arm the settle
        // probe up front. The probe's generation and activity checks keep it
        // harmless when agent activity follows.
        if (turn.mayBeCommandOnly) {
          yield* scheduleSettleProbe(ctx, turn, false).pipe(Effect.forkIn(ctx.scope));
        }
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
      payload: (nativeRequestId: string) => PiRpcRecord,
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
          .send(payload(pending.nativeRequestId))
          .pipe(Effect.mapError((cause) => adapterError(threadId, "extension_ui_response", cause)));
        return pending;
      });

    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ) =>
      Effect.gen(function* () {
        const pending = yield* respondToExtensionUi(threadId, requestId, (nativeRequestId) => {
          const confirmed =
            decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
          return {
            type: "extension_ui_response",
            id: nativeRequestId,
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
        const pending = yield* respondToExtensionUi(threadId, requestId, (nativeRequestId) => {
          const answer = answers[nativeRequestId];
          return {
            type: "extension_ui_response",
            id: nativeRequestId,
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

    const stopAll = Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      discard: true,
    });

    yield* Effect.addFinalizer(() => Effect.ignore(stopAll));

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
      stopAll: () => stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
