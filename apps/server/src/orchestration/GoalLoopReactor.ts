/**
 * GoalLoopReactor — turns a thread goal into continuation turns.
 *
 * A T3-driven goal loop (see `ThreadGoalLoop`) needs something to keep asking
 * the agent to continue. This reactor is that something: when a turn has
 * fully ended it reads the turn's last assistant message, honours the
 * `<goal_complete>` / `<goal_blocked>` tags the goal injection asked for, and
 * otherwise starts the next continuation turn.
 *
 * The end-of-turn signal is the `thread.turn-diff-completed` domain event.
 * That event is only dispatched by `CheckpointReactor` after the checkpoint
 * is captured and the turn diff is finalized, so continuing on it can never
 * race checkpointing. (`turn.processing.quiesced` marks the same point but
 * rides `RuntimeReceiptBus`, whose production layer is a deliberate no-op.)
 *
 * Every command the reactor dispatches is keyed on the turn that just ended.
 * The engine replays a command id it has already accepted, so the key has to
 * be unique per goal generation: keying on the loop's iteration count instead
 * collides after a replaced goal resets it, and the engine then silently
 * swallows the new goal's complete/block/continue.
 *
 * The other wake is `thread.goal-loop-updated` with `resumed`, which the
 * decider sets when a user resumes/resets a held loop or sets a fresh goal. A
 * newly active goal therefore gets its first turn immediately rather than
 * waiting for another user message.
 *
 * @module GoalLoopReactor
 */
import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadGoalLoop,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import { ExperimentService } from "../experiments/ExperimentService.ts";
import { NativeChildRunRepositoryAuto } from "../persistence/Layers/NativeChildRuns.ts";
import { NativeChildRunRepository } from "../persistence/Services/NativeChildRuns.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "./Services/RuntimeReceiptBus.ts";

/** Text a continuation turn sends as the user message. */
export const GOAL_CONTINUE_MESSAGE = "Continue working toward the thread goal.";

const BLOCKED_FALLBACK_REASON = "Agent reported it is blocked";
const EMPTY_OUTPUT_REASON = "Agent produced no output on two continuations";

const GOAL_COMPLETE_PATTERN = /<goal_complete\s*\/?>/gi;
const GOAL_BLOCKED_PATTERN = /<goal_blocked>([\s\S]*?)<\/goal_blocked>/gi;

export type GoalSignal =
  | { readonly kind: "complete" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Reads the goal-loop tags out of one assistant message. Case-insensitive,
 * and the last tag in the text wins so an agent that quotes an earlier reply
 * cannot retroactively complete or block the loop.
 */
export function scanGoalSignal(text: string): GoalSignal | null {
  let bestIndex = -1;
  let best: GoalSignal | null = null;
  for (const match of text.matchAll(GOAL_COMPLETE_PATTERN)) {
    if (match.index >= bestIndex) {
      bestIndex = match.index;
      best = { kind: "complete" };
    }
  }
  for (const match of text.matchAll(GOAL_BLOCKED_PATTERN)) {
    if (match.index >= bestIndex) {
      bestIndex = match.index;
      best = { kind: "blocked", reason: match[1]?.trim() || BLOCKED_FALLBACK_REASON };
    }
  }
  return best;
}

/**
 * Whether the loop may be evaluated right now. The iteration ceiling is
 * checked after the ended turn's status tag, so the final allowed turn may
 * still complete the goal.
 */
export function canDriveGoalLoop(
  thread: OrchestrationThreadShell,
): thread is OrchestrationThreadShell & { readonly goalLoop: ThreadGoalLoop } {
  const loop = thread.goalLoop;
  if (thread.goal == null || loop == null) return false;
  if (loop.state !== "running" && loop.state !== "idle") return false;
  if (loop.mode !== "t3") return false;
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return false;
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan
  ) {
    return false;
  }
  if (thread.archivedAt != null || thread.settledOverride === "settled") return false;
  if (thread.snoozedUntil != null) return false;
  return true;
}

/** The turn's last assistant message, or the thread's when no turn is named. */
function lastAssistantText(thread: OrchestrationThread, turnId: TurnId | null): string | null {
  const message = thread.messages
    .toReversed()
    .find((entry) => entry.role === "assistant" && (turnId === null || entry.turnId === turnId));
  return message?.text ?? null;
}

export class GoalLoopReactor extends Context.Service<
  GoalLoopReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/GoalLoopReactor") {}

interface Signal {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  /**
   * Set when a fresh goal or user action hands an idle loop back, to the
   * loop's `updatedAt`. Such a signal starts the next turn straight away once
   * the thread is driveable and never scans the last assistant message: that
   * message may carry the stale tag that stopped a previous goal generation.
   */
  readonly resumedAt?: string;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const receipts = yield* RuntimeReceiptBus;
  const experiments = yield* Effect.serviceOption(ExperimentService);
  const childRuns = yield* NativeChildRunRepository;

  // Consecutive continuations that produced no assistant text, per thread.
  // ponytail: in-memory, so a server restart forgives one empty turn. The
  // durable alternative is another projected counter; not worth it until an
  // agent is observed wedging silently across a restart.
  const emptyRuns = new Map<ThreadId, number>();

  // A goal can be set while the current turn is still running. Keep that
  // explicit wake until the turn-end signal makes the thread driveable, or
  // until a clear/pause/terminal update makes it stale.
  const pendingResumes = new Map<ThreadId, string>();

  const canRetainResume = (thread: OrchestrationThreadShell): boolean => {
    const loop = thread.goalLoop;
    return (
      thread.goal != null &&
      loop != null &&
      (loop.state === "idle" || loop.state === "running") &&
      loop.mode === "t3" &&
      loop.iterations < loop.maxIterations &&
      thread.archivedAt == null &&
      thread.settledOverride !== "settled" &&
      thread.snoozedUntil == null
    );
  };

  const dispatchLoopAction = Effect.fn("GoalLoopReactor.dispatchLoopAction")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnKey: string;
    readonly action: "complete" | "block" | "continue";
    readonly loopUpdatedAt: string;
    readonly maxIterations: number;
    readonly allowPendingChildren?: boolean;
    readonly reason?: string;
  }) {
    yield* engine.dispatch({
      type: "thread.goal.loop",
      commandId: CommandId.make(`server:goal-${input.action}:${input.threadId}:${input.turnKey}`),
      threadId: input.threadId,
      action: "sync",
      state:
        input.action === "complete" ? "completed" : input.action === "block" ? "blocked" : "capped",
      ...(input.action === "continue"
        ? { reason: `Reached ${input.maxIterations} iterations.` }
        : input.reason === undefined
          ? {}
          : { reason: input.reason }),
      goalLoopGuard: { updatedAt: input.loopUpdatedAt },
      ...(input.allowPendingChildren === true ? {} : { onlyIfNoRequiredChildren: true as const }),
    });
  });

  const startContinuationTurn = Effect.fn("GoalLoopReactor.startContinuationTurn")(function* (
    thread: OrchestrationThreadShell,
    turnKey: string,
  ) {
    const loop = thread.goalLoop;
    if (loop == null) return;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // Keyed on the turn that just ended, so a replayed or duplicated
    // end-of-turn signal collapses onto the same command while a later turn
    // — including the first turn of a replaced goal — gets a fresh one.
    const key = `${thread.id}:${turnKey}`;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:goal-continue:${key}`),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(`goal-continue:${key}`),
        role: "user",
        text: GOAL_CONTINUE_MESSAGE,
        attachments: [],
        origin: "goal-continue",
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      continuation: true,
      onlyIfIdle: true,
      goalLoopGuard: { updatedAt: loop.updatedAt },
      onlyIfNoRequiredChildren: true,
      createdAt,
    });
    yield* receipts.publish({
      type: "goal.loop.continued",
      threadId: thread.id,
      iterations: loop.iterations,
      createdAt,
    });
  });

  const evaluate = Effect.fn("GoalLoopReactor.evaluate")(function* (signal: Signal) {
    if (signal.resumedAt !== undefined) pendingResumes.set(signal.threadId, signal.resumedAt);
    const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(signal.threadId));
    if (thread === undefined) {
      pendingResumes.delete(signal.threadId);
      return;
    }
    const resumedAt = signal.resumedAt ?? pendingResumes.get(signal.threadId);
    if (!canDriveGoalLoop(thread)) {
      if (!canRetainResume(thread)) pendingResumes.delete(signal.threadId);
      return;
    }
    const loop = thread.goalLoop;
    if (loop == null) return;
    if (loop.kind === "experiment") {
      if (Option.isNone(experiments)) {
        pendingResumes.delete(signal.threadId);
        return;
      }
      if (resumedAt !== undefined) yield* experiments.value.resume(thread.id);
      if (!(yield* experiments.value.canContinue(thread.id))) {
        pendingResumes.delete(signal.threadId);
        return;
      }
    }
    const childWork = yield* childRuns.getParentWorkState(signal.threadId);
    if (childWork.active > 0) {
      // The child result owns the next parent turn. The explicit wake has
      // been consumed by waiting for that required work, and retaining it
      // would outrank the result turn's completion tag later.
      pendingResumes.delete(signal.threadId);
      return;
    }
    if (childWork.pendingDelivery > 0) {
      pendingResumes.delete(signal.threadId);
      // Delivery owns the next automatic turn. At the ceiling it stays
      // durable until the user resets the goal budget.
      if (loop.iterations >= loop.maxIterations) {
        yield* dispatchLoopAction({
          threadId: signal.threadId,
          turnKey: `cap:${loop.updatedAt}`,
          action: "continue",
          loopUpdatedAt: loop.updatedAt,
          maxIterations: loop.maxIterations,
          allowPendingChildren: true,
        });
      }
      return;
    }
    if (resumedAt !== undefined) {
      // Explicit user intent, so it outranks the error-session hold below.
      emptyRuns.delete(signal.threadId);
      pendingResumes.delete(signal.threadId);
      return yield* startContinuationTurn(thread, `resume:${resumedAt}`);
    }
    // A failed turn leaves the loop exactly as it is: the user decides
    // whether to retry, and a retry storm on a broken session helps nobody.
    if (thread.session?.status === "error") return;

    // Unique per goal generation. A boot sweep has no turn to name, so it
    // falls back to the loop's own timestamp, which still dedupes a double
    // start against the same stale loop.
    const turnKey =
      signal.turnId ?? thread.session?.activeTurnId ?? `boot:${thread.goalLoop?.updatedAt ?? ""}`;

    const detail = Option.getOrUndefined(
      yield* snapshots.getThreadDetailById(signal.threadId, { activityKinds: [] }),
    );
    const text = detail === undefined ? null : lastAssistantText(detail, signal.turnId);
    const signalTag = text === null ? null : scanGoalSignal(text);

    if (signalTag?.kind === "complete") {
      emptyRuns.delete(signal.threadId);
      return yield* dispatchLoopAction({
        threadId: signal.threadId,
        turnKey,
        action: "complete",
        loopUpdatedAt: loop.updatedAt,
        maxIterations: loop.maxIterations,
      });
    }
    if (signalTag?.kind === "blocked") {
      emptyRuns.delete(signal.threadId);
      return yield* dispatchLoopAction({
        threadId: signal.threadId,
        turnKey,
        action: "block",
        loopUpdatedAt: loop.updatedAt,
        maxIterations: loop.maxIterations,
        reason: signalTag.reason,
      });
    }

    if (loop.iterations >= loop.maxIterations) {
      emptyRuns.delete(signal.threadId);
      return yield* dispatchLoopAction({
        threadId: signal.threadId,
        turnKey,
        action: "continue",
        loopUpdatedAt: loop.updatedAt,
        maxIterations: loop.maxIterations,
      });
    }

    if (text === null || text.trim() === "") {
      const runs = (emptyRuns.get(signal.threadId) ?? 0) + 1;
      emptyRuns.set(signal.threadId, runs);
      if (runs >= 2) {
        emptyRuns.delete(signal.threadId);
        return yield* dispatchLoopAction({
          threadId: signal.threadId,
          turnKey,
          action: "block",
          loopUpdatedAt: loop.updatedAt,
          maxIterations: loop.maxIterations,
          reason: EMPTY_OUTPUT_REASON,
        });
      }
    } else {
      emptyRuns.delete(signal.threadId);
    }

    yield* startContinuationTurn(thread, turnKey);
  });

  const worker = yield* makeDrainableWorker((signal: Signal) =>
    evaluate(signal).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("goal loop reactor failed to evaluate thread", {
              threadId: signal.threadId,
              turnId: signal.turnId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  // A restart can lose either the end-of-turn event for a running loop or the
  // resumed event for an idle loop. Sweep both. An idle loop represents fresh
  // user intent, so do not re-read the previous goal generation's final tag.
  const sweep = Effect.fn("GoalLoopReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    yield* Effect.forEach(
      snapshot.threads.filter(
        (thread) =>
          (thread.goalLoop?.state === "idle" || thread.goalLoop?.state === "running") &&
          canDriveGoalLoop(thread),
      ),
      (thread) => {
        const loop = thread.goalLoop;
        return worker.enqueue({
          threadId: thread.id,
          turnId: null,
          ...(loop?.state === "idle" ? { resumedAt: loop.updatedAt } : {}),
        });
      },
      { discard: true },
    );
  });

  const start: GoalLoopReactor["Service"]["start"] = Effect.fn("GoalLoopReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          // Acquire the subscription before reading the snapshot. A native
          // takeover may commit while this sweep runs; the buffered event is
          // then the recovery wake for a loop the snapshot still called native.
          const domainEvents = yield* engine.subscribeDomainEvents;
          yield* sweep().pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("goal loop reactor boot sweep failed", {
                    cause: Cause.pretty(cause),
                  }),
            ),
          );
          yield* Stream.runForEach(domainEvents, (event: OrchestrationEvent) => {
            if (event.type === "thread.turn-diff-completed") {
              return worker.enqueue({
                threadId: event.payload.threadId,
                turnId: event.payload.turnId,
              });
            }
            if (
              event.type === "thread.activity-appended" &&
              event.payload.activity.kind === "task.completed"
            ) {
              return worker.enqueue({
                threadId: event.payload.threadId,
                turnId: null,
              });
            }
            // Goal activation, resume, and "continue anyway" have no turn to
            // end, so the loop update is their start signal. These actions set
            // `resumed`; a paused goal remains held and does not wake us.
            if (event.type === "thread.goal-loop-updated" && event.payload.resumed === true) {
              const loop = event.payload.loop;
              return loop !== null && loop.state === "idle"
                ? worker.enqueue({
                    threadId: event.payload.threadId,
                    turnId: null,
                    resumedAt: loop.updatedAt,
                  })
                : Effect.void;
            }
            // A persisted standard Codex loop changes from native to T3 only
            // after NativeGoalReactor has safely handed it over. Its dedicated
            // takeover command is a recovery wake because our boot sweep may
            // already have skipped the legacy native projection.
            if (
              event.type === "thread.goal-loop-updated" &&
              event.commandId?.startsWith("server:native-goal-takeover:") === true
            ) {
              const loop = event.payload.loop;
              return loop !== null &&
                loop.mode === "t3" &&
                (loop.state === "idle" || loop.state === "running")
                ? worker.enqueue({ threadId: event.payload.threadId, turnId: null })
                : Effect.void;
            }
            if (event.type === "thread.session-set" && pendingResumes.has(event.payload.threadId)) {
              return worker.enqueue({ threadId: event.payload.threadId, turnId: null });
            }
            return Effect.void;
          });
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies GoalLoopReactor["Service"];
});

export const layerWithRepository = Layer.effect(GoalLoopReactor, make);

export const layer = layerWithRepository.pipe(Layer.provide(NativeChildRunRepositoryAuto));
