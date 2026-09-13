/**
 * NativeGoalReactor — keeps T3-owned and Codex-owned goals exclusive.
 *
 * Standard thread goals run through T3 for every provider. Before T3 takes a
 * Codex goal over, this reactor clears any provider execution goal. It changes
 * a persisted native loop to T3 mode only after that clear succeeds. A failed
 * clear therefore leaves the old driver in charge.
 *
 * Restricted experiments keep their existing native Codex goal binding and
 * mirroring. Provider goal notifications for standard loops are never mirrored
 * into T3 state. A non-null notification means Codex recreated a competing
 * goal, so the reactor clears it and holds future T3 scheduling if that fails.
 *
 * A thread with no live session is not a failure — the push simply waits for
 * `thread.session-set`. A real deactivation failure leaves a legacy native
 * loop untouched, or holds an already-T3 loop before it can schedule again.
 *
 * @module NativeGoalReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
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

  // Last native state successfully set or cleared per thread. Restarting
  // repeats the idempotent RPC, which also makes cold-start takeover safe.
  const lastPushed = new Map<ThreadId, string>();
  // Threads this process has observed with a T3-managed goal. This lets a
  // later explicit goal clear clean up that native binding without touching
  // an unrelated execution goal on an ordinary Codex thread.
  const managedGoalThreads = new Set<ThreadId>();

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
    readonly takeover?: true;
  }) {
    yield* engine.dispatch({
      type: "thread.goal.loop",
      commandId: yield* serverCommandId(
        input.takeover === true ? "native-goal-takeover" : "goal-sync",
        input.threadId,
      ),
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
      goalLoopGuard: { updatedAt: loop.updatedAt },
      createdAt,
    });
    startedBootstraps.set(thread.id, key);
    pendingBootstraps.delete(thread.id);
  });

  const isLiveCodex = (thread: OrchestrationThreadShell) =>
    thread.session?.providerName === "codex" && thread.session.status !== "stopped";

  /** Experiments retain native Codex execution goals; standard goals never do. */
  const derivedMode = (thread: OrchestrationThreadShell) => {
    const loop = thread.goalLoop;
    if (loop?.kind !== "experiment") return "t3" as const;
    if (thread.session?.providerName === "codex") return "native" as const;
    if (thread.session != null && thread.session.status !== "stopped") return "t3" as const;
    // Paused experiments intentionally stop their restricted provider
    // session. Preserve the configured driver until a real replacement
    // session proves otherwise.
    return loop.mode;
  };

  const clearNativeGoal = Effect.fn("NativeGoalReactor.clearNativeGoal")(function* (input: {
    readonly threadId: ThreadId;
    readonly failureSummary: string;
  }) {
    return yield* providerService.clearExecutionGoal({ threadId: input.threadId }).pipe(
      Effect.as("cleared" as const),
      Effect.catch((error) =>
        error._tag === "ProviderSessionNotFoundError" ||
        error._tag === "ProviderAdapterSessionNotFoundError"
          ? Effect.succeed("unavailable" as const)
          : appendFailureActivity({
              threadId: input.threadId,
              summary: input.failureSummary,
              detail: error.message,
            }).pipe(Effect.as("failed" as const)),
      ),
    );
  });

  const push = Effect.fn("NativeGoalReactor.push")(function* (threadId: ThreadId) {
    const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(threadId));
    if (thread === undefined) return;
    const loop = thread.goalLoop;
    if (loop == null || thread.goal == null) {
      lastPushed.delete(threadId);
      pendingBootstraps.delete(threadId);
      startedBootstraps.delete(threadId);
      if (managedGoalThreads.delete(threadId) && isLiveCodex(thread)) {
        yield* clearNativeGoal({
          threadId,
          failureSummary: "Could not clear the Codex execution goal",
        });
      }
      return;
    }
    managedGoalThreads.add(threadId);
    const mode = derivedMode(thread);
    if (loop.kind === "standard") {
      pendingBootstraps.delete(threadId);
      startedBootstraps.delete(threadId);
      if (!isLiveCodex(thread)) {
        // With no live Codex session there is no native driver to deactivate.
        // Hand ownership to T3 now; ProviderCommandReactor repeats the clear
        // after any future Codex session is created and before its first turn.
        if (loop.mode !== "t3") {
          yield* dispatchSync({ threadId, mode: "t3", takeover: true });
        }
        return;
      }
      const clearResult = yield* clearNativeGoal({
        threadId,
        failureSummary: "Could not deactivate the Codex execution goal",
      });
      if (clearResult !== "cleared") {
        if (
          clearResult === "failed" &&
          loop.mode === "t3" &&
          (loop.state === "idle" || loop.state === "running")
        ) {
          yield* dispatchSync({
            threadId,
            state: "blocked",
            reason: "The Codex execution goal could not be deactivated",
          });
        }
        return;
      }
      if (loop.mode !== "t3") {
        yield* dispatchSync({ threadId, mode: "t3", takeover: true });
      }
      return;
    }
    if (loop.mode !== mode) yield* dispatchSync({ threadId, mode });
    if (mode !== "native") return;
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
    if (loop.kind === "standard") {
      if (status === null || !isLiveCodex(thread)) return;
      const nativeGoal = yield* providerService.getExecutionGoal({ threadId }).pipe(
        Effect.map((result) => result.goal),
        Effect.catch((error) =>
          error._tag === "ProviderSessionNotFoundError" ||
          error._tag === "ProviderAdapterSessionNotFoundError"
            ? Effect.succeed(null)
            : appendFailureActivity({
                threadId,
                summary: "Could not verify the Codex execution goal",
                detail: error.message,
              }).pipe(Effect.as(null)),
        ),
      );
      // Provider notifications can arrive after the native goal was already
      // cleared. Confirm live state before treating one as a competing goal.
      if (nativeGoal === null) return;
      lastPushed.delete(threadId);
      const clearResult = yield* clearNativeGoal({
        threadId,
        failureSummary: "Could not deactivate a competing Codex execution goal",
      });
      if (clearResult === "failed" && (loop.state === "idle" || loop.state === "running")) {
        yield* dispatchSync({
          threadId,
          state: "blocked",
          reason: "A competing Codex execution goal could not be deactivated",
        });
      }
      return;
    }
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

  // Session reconciliation finishes before reactor activation. Sweep the
  // projection once so persisted native standard loops cannot wait forever
  // for a lifecycle event that already happened.
  const sweep = Effect.fn("NativeGoalReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    yield* Effect.forEach(
      snapshot.threads.filter((thread) => thread.goal != null && thread.goalLoop != null),
      (thread) => worker.enqueue({ kind: "push", threadId: thread.id }),
      { discard: true },
    );
  });

  const start: NativeGoalReactor["Service"]["start"] = Effect.fn("NativeGoalReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          // Subscribe before the snapshot sweep so goal/session events that
          // race startup are buffered rather than lost between the two phases.
          const domainEvents = yield* engine.subscribeDomainEvents;
          yield* Effect.forkChild(
            Stream.runForEach(providerService.streamEvents, (event) =>
              event.type === "thread.goal.updated"
                ? worker.enqueue({
                    kind: "mirror",
                    threadId: event.threadId,
                    status: event.payload.status,
                  })
                : Effect.void,
            ),
            { startImmediately: true },
          );
          yield* sweep().pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("native goal reactor boot sweep failed", {
                    cause: Cause.pretty(cause),
                  }),
            ),
          );
          yield* Stream.runForEach(domainEvents, (event: OrchestrationEvent) =>
            event.type === "thread.goal-loop-updated"
              ? Effect.sync(() => {
                  if (event.payload.resumed === true && event.payload.loop?.state === "idle") {
                    pendingBootstraps.set(event.payload.threadId, event.eventId);
                  } else if (event.payload.loop === null) {
                    // A null loop event is the durable evidence that a
                    // previously managed thread goal was explicitly cleared.
                    managedGoalThreads.add(event.payload.threadId);
                    pendingBootstraps.delete(event.payload.threadId);
                  } else if (
                    event.payload.loop.state !== "idle" &&
                    event.payload.loop.state !== "running"
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
          );
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies NativeGoalReactor["Service"];
});

export const layer = Layer.effect(NativeGoalReactor, make);
