/**
 * NativeGoalReactor — binds a T3 thread goal to Codex's own execution goal.
 *
 * In `native` mode (see `ThreadGoalLoop`) T3 does not drive continuation
 * turns; Codex does, from its own execution goal. This reactor is the two-way
 * binding between the two:
 *
 * - **Push.** Setting the T3 goal sets the Codex execution goal to the same
 *   text; clearing it clears Codex's. A T3 pause sends `status: "paused"` and
 *   a resume sends `status: "active"` — Codex has no separate resume RPC.
 *   Activating a goal also sends one hidden, idle-only bootstrap turn. The
 *   turn wakes Codex after a goal is added; Codex owns every continuation after
 *   that first turn.
 * - **Mirror.** Codex's `thread/goal/updated` and `thread/goal/cleared`
 *   notifications arrive as `thread.goal.updated` runtime events and are
 *   written back onto `goalLoop.state` read-only, via the `sync` action. T3
 *   never resumes a goal Codex paused.
 * - **Mode.** The decider can only guess the mode from the thread's instance
 *   id, which is wrong for a custom Codex instance. Whenever this reactor
 *   sees the thread it re-derives the mode from the bound session's real
 *   driver and corrects it with the same `sync` action.
 *
 * The escape hatch matters more than the binding: if the Codex set/clear RPC
 * fails, the T3 goal change still stands and the failure is surfaced as a
 * thread activity. A user must never be stuck with a goal they cannot clear.
 * A thread with no live session is not a failure — the push simply waits for
 * `thread.session-set`.
 *
 * @module NativeGoalReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
  resolveThreadGoalLoopMode,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ProviderExecutionGoalStatus,
  type ThreadGoalLoopState,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/** Reason a mirrored loop carries when Codex threw the goal away itself. */
export const CODEX_CLEARED_REASON = "Codex cleared its execution goal";

/** The one server-authored prompt that wakes a newly activated native goal. */
export const NATIVE_GOAL_BOOTSTRAP_MESSAGE = "Continue working toward the thread goal.";

/**
 * Codex's execution-goal status as a T3 loop state. `null` is Codex having
 * cleared a goal T3 still holds, which is a block, not a completion — the
 * work was neither finished nor abandoned by the user.
 */
export function mirrorState(status: ProviderExecutionGoalStatus | null): {
  readonly state: ThreadGoalLoopState;
  readonly reason?: string;
} {
  switch (status) {
    case null:
      return { state: "blocked", reason: CODEX_CLEARED_REASON };
    case "active":
      return { state: "running" };
    case "paused":
      return { state: "paused" };
    case "complete":
      return { state: "completed" };
    case "blocked":
      return { state: "blocked", reason: "Codex reported its execution goal is blocked" };
    case "usageLimited":
      return { state: "blocked", reason: "Codex paused its execution goal on a usage limit" };
    case "budgetLimited":
      return { state: "blocked", reason: "Codex paused its execution goal on a token budget" };
  }
}

/**
 * What Codex should be holding for this thread right now, or `null` to clear.
 * `undefined` means "leave Codex alone": the terminal states are Codex's own
 * verdict arriving back through the mirror, so pushing them would fight it.
 */
export function desiredCodexGoal(
  goal: string | null,
  state: ThreadGoalLoopState,
): { readonly objective: string; readonly status: "active" | "paused" } | null | undefined {
  if (goal === null) return null;
  switch (state) {
    case "paused":
      return { objective: goal, status: "paused" };
    case "idle":
    case "running":
      return { objective: goal, status: "active" };
    case "blocked":
    case "completed":
    case "capped":
      return undefined;
  }
}

export class NativeGoalReactor extends Context.Service<
  NativeGoalReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/NativeGoalReactor") {}

type Signal =
  | { readonly kind: "push"; readonly threadId: ThreadId }
  | {
      readonly kind: "mirror";
      readonly threadId: ThreadId;
      readonly status: ProviderExecutionGoalStatus | null;
    };

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const crypto = yield* Crypto.Crypto;

  const serverCommandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  // Last state successfully pushed to Codex, per thread. Purely an echo
  // guard: the mirror writes T3 state, which re-fires the push, which would
  // otherwise re-send what Codex just told us.
  // ponytail: in-memory, so a restart re-sends one redundant set. The set is
  // idempotent, so a durable version buys nothing.
  const lastPushed = new Map<ThreadId, string>();

  // A resumed marker is emitted with the goal-loop event, but that event can
  // arrive while the provider is still finishing a turn or before its session
  // is registered. Keep the marker until one of those lifecycle events makes a
  // normal idle-only turn start safe.
  const pendingBootstraps = new Map<ThreadId, string>();
  const startedBootstraps = new Map<ThreadId, string>();

  const pushKey = (desired: ReturnType<typeof desiredCodexGoal>) =>
    desired === undefined ? undefined : JSON.stringify(desired);

  const appendFailureActivity = Effect.fn("NativeGoalReactor.appendFailureActivity")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly summary: string;
      readonly detail: string;
    }) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("native-goal-failure", input.threadId),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          // `error` is the loudest tone the activity contract has; there is no
          // separate warning tone.
          tone: "error",
          kind: "goal.native.failed",
          summary: input.summary,
          payload: { detail: input.detail },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    },
  );

  const dispatchSync = Effect.fn("NativeGoalReactor.dispatchSync")(function* (input: {
    readonly threadId: ThreadId;
    readonly state?: ThreadGoalLoopState;
    readonly mode?: "native" | "t3" | "unsupported";
    readonly reason?: string;
  }) {
    yield* engine.dispatch({
      type: "thread.goal.loop",
      commandId: yield* serverCommandId("goal-sync", input.threadId),
      threadId: input.threadId,
      action: "sync",
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  });

  const startBootstrap = Effect.fn("NativeGoalReactor.startBootstrap")(function* (
    thread: OrchestrationThreadShell,
  ) {
    const loop = thread.goalLoop;
    if (
      loop == null ||
      (loop.state !== "idle" && loop.state !== "running") ||
      thread.goal == null ||
      thread.session == null ||
      thread.session.status === "stopped"
    ) {
      return;
    }
    if (
      thread.archivedAt != null ||
      thread.settledOverride === "settled" ||
      thread.snoozedUntil != null
    ) {
      pendingBootstraps.delete(thread.id);
      return;
    }
    if (
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.hasActionableProposedPlan
    ) {
      return;
    }
    const pending = pendingBootstraps.get(thread.id);
    if (pending === undefined) return;
    // The native provider owns subsequent turns. This command is only the
    // first wake for this goal generation, and the deterministic key protects
    // against replayed domain events in addition to this process-local guard.
    const key = pending;
    if (startedBootstraps.get(thread.id) === key) {
      pendingBootstraps.delete(thread.id);
      return;
    }
    if (thread.session.status === "starting" || thread.session.status === "running") return;

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:native-goal-start:${thread.id}:${key}`),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(`native-goal-start:${thread.id}:${key}`),
        role: "user",
        text: NATIVE_GOAL_BOOTSTRAP_MESSAGE,
        attachments: [],
        origin: "goal-continue",
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      onlyIfIdle: true,
      createdAt,
    });
    startedBootstraps.set(thread.id, key);
    pendingBootstraps.delete(thread.id);
  });

  /** Mode the thread's real driver implies, not the decider's instance-id guess. */
  const derivedMode = (thread: OrchestrationThreadShell) =>
    resolveThreadGoalLoopMode(thread.session?.providerName ?? thread.modelSelection.instanceId);

  const push = Effect.fn("NativeGoalReactor.push")(function* (threadId: ThreadId) {
    const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
    if (thread === undefined) return;
    const loop = thread.goalLoop;
    if (loop == null) {
      lastPushed.delete(threadId);
      pendingBootstraps.delete(threadId);
      startedBootstraps.delete(threadId);
      return;
    }
    const mode = derivedMode(thread);
    if (loop.mode !== mode) {
      yield* dispatchSync({ threadId, mode });
    }
    if (mode !== "native") {
      // A missing session may still become Codex when it is registered, so
      // retain the wake for that transition. Once a live non-native driver is
      // known, the T3 reactor owns this goal instead.
      if (thread.session !== null) pendingBootstraps.delete(threadId);
      return;
    }
    // No live session yet: `thread.session-set` brings us back here.
    if (thread.session == null || thread.session.status === "stopped") return;

    // Pausing an experiment tears down its restricted provider session. Do
    // not race that teardown with a native goal RPC, and forget the old echo
    // key so the fresh restricted session receives the goal when resumed.
    if (loop.kind === "experiment" && loop.state === "paused") {
      lastPushed.delete(threadId);
      return;
    }

    const desired = desiredCodexGoal(thread.goal ?? null, loop.state);
    const key = pushKey(desired);
    if (key === undefined) {
      pendingBootstraps.delete(threadId);
      return;
    }

    const needsPush = lastPushed.get(threadId) !== key;
    const pushed = needsPush
      ? yield* (
          desired === null
            ? providerService.clearExecutionGoal({ threadId })
            : providerService.setExecutionGoal({ threadId, ...desired }).pipe(Effect.asVoid)
        ).pipe(
          Effect.flatMap(() =>
            Effect.sync(() => {
              lastPushed.set(threadId, key);
              return true;
            }),
          ),
          // The T3 goal change already landed; only the provider mirror failed.
          // Surface it instead of silently leaving the two out of sync.
          Effect.catch((error) =>
            error._tag === "ProviderSessionNotFoundError" ||
            error._tag === "ProviderAdapterSessionNotFoundError"
              ? Effect.succeed(false)
              : appendFailureActivity({
                  threadId,
                  summary:
                    desired === null
                      ? "Could not clear the Codex execution goal"
                      : "Could not set the Codex execution goal",
                  detail: error.message,
                }).pipe(Effect.as(false)),
          ),
        )
      : true;

    if (desired === null) {
      pendingBootstraps.delete(threadId);
      return;
    }
    if (pushed && mode === "native") yield* startBootstrap(thread);
  });

  const mirror = Effect.fn("NativeGoalReactor.mirror")(function* (
    threadId: ThreadId,
    status: ProviderExecutionGoalStatus | null,
  ) {
    const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
    const loop = thread?.goalLoop;
    if (thread === undefined || loop == null || thread.goal == null) return;
    if (derivedMode(thread) !== "native") return;

    const { state, reason } = mirrorState(status);
    if (loop.state === state) return;
    // Codex just told us this, so record it as pushed: the goal-loop event
    // this dispatch produces must not bounce straight back at Codex.
    const key = pushKey(desiredCodexGoal(thread.goal ?? null, state));
    if (key !== undefined) lastPushed.set(threadId, key);
    yield* dispatchSync({
      threadId,
      state,
      ...(reason !== undefined ? { reason } : {}),
    });
  });

  const worker = yield* makeDrainableWorker((signal: Signal) =>
    (signal.kind === "push" ? push(signal.threadId) : mirror(signal.threadId, signal.status)).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("native goal reactor failed to handle signal", {
              threadId: signal.threadId,
              kind: signal.kind,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: NativeGoalReactor["Service"]["start"] = Effect.fn("NativeGoalReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* Effect.forkChild(
            Stream.runForEach(engine.streamDomainEvents, (event: OrchestrationEvent) =>
              event.type === "thread.goal-loop-updated"
                ? Effect.sync(() => {
                    if (event.payload.resumed === true && event.payload.loop?.state === "idle") {
                      pendingBootstraps.set(event.payload.threadId, event.eventId);
                    } else if (
                      event.payload.loop === null ||
                      (event.payload.loop.state !== "idle" &&
                        event.payload.loop.state !== "running")
                    ) {
                      pendingBootstraps.delete(event.payload.threadId);
                    }
                  }).pipe(
                    Effect.andThen(
                      worker.enqueue({ kind: "push", threadId: event.payload.threadId }),
                    ),
                  )
                : event.type === "thread.meta-updated" ||
                    event.type === "thread.session-set" ||
                    event.type === "thread.turn-diff-completed" ||
                    event.type === "thread.approval-response-requested" ||
                    event.type === "thread.user-input-response-requested" ||
                    event.type === "thread.proposed-plan-upserted" ||
                    event.type === "thread.archived" ||
                    event.type === "thread.settled" ||
                    event.type === "thread.unsettled" ||
                    event.type === "thread.snoozed" ||
                    event.type === "thread.unsnoozed" ||
                    event.type === "thread.reverted"
                  ? worker.enqueue({ kind: "push", threadId: event.payload.threadId })
                  : Effect.void,
            ),
          );
          yield* Stream.runForEach(providerService.streamEvents, (event) =>
            event.type === "thread.goal.updated"
              ? worker.enqueue({
                  kind: "mirror",
                  threadId: event.threadId,
                  status: event.payload.status,
                })
              : Effect.void,
          );
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies NativeGoalReactor["Service"];
});

export const layer = Layer.effect(NativeGoalReactor, make);
