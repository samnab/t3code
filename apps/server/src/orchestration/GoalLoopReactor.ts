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
 * decider sets only for the `resume` and `reset` actions: a user who resumes a
 * paused loop or pushes past the iteration cap gets the next turn immediately
 * rather than having to send a message.
 *
 * @module GoalLoopReactor
 */
import {
  CommandId,
  MessageId,
  resolveThreadGoalLoopMode,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadShell,
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
 * Whether the loop may be driven at all right now. Mode is re-derived from
 * the bound session's real driver rather than trusted from the stored loop,
 * which the decider could only guess from the instance id.
 */
export function canDriveGoalLoop(thread: OrchestrationThreadShell): boolean {
  const loop = thread.goalLoop;
  if (thread.goal == null || loop == null) return false;
  if (loop.state !== "running" && loop.state !== "idle") return false;
  if (
    resolveThreadGoalLoopMode(thread.session?.providerName ?? thread.modelSelection.instanceId) !==
    "t3"
  ) {
    return false;
  }
  if (loop.iterations >= loop.maxIterations) return false;
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
   * Set when a user resumed or reset a held loop, to the loop's `updatedAt`.
   * Such a signal starts the next turn straight away and never scans the last
   * assistant message: that message is the one whose `<goal_blocked>` or
   * `<goal_complete>` tag stopped the loop, and re-reading it would just stop
   * it again.
   */
  readonly resumedAt?: string;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const receipts = yield* RuntimeReceiptBus;

  // Consecutive continuations that produced no assistant text, per thread.
  // ponytail: in-memory, so a server restart forgives one empty turn. The
  // durable alternative is another projected counter; not worth it until an
  // agent is observed wedging silently across a restart.
  const emptyRuns = new Map<ThreadId, number>();

  const dispatchLoopAction = Effect.fn("GoalLoopReactor.dispatchLoopAction")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnKey: string;
    readonly action: "complete" | "block";
    readonly reason?: string;
  }) {
    yield* engine.dispatch({
      type: "thread.goal.loop",
      commandId: CommandId.make(`server:goal-${input.action}:${input.threadId}:${input.turnKey}`),
      threadId: input.threadId,
      action: input.action,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
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
    const thread = Option.getOrUndefined(yield* snapshots.getThreadShellById(signal.threadId));
    if (thread === undefined || !canDriveGoalLoop(thread)) return;
    if (signal.resumedAt !== undefined) {
      // Explicit user intent, so it outranks the error-session hold below.
      emptyRuns.delete(signal.threadId);
      return yield* startContinuationTurn(thread, `resume:${signal.resumedAt}`);
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
      });
    }
    if (signalTag?.kind === "blocked") {
      emptyRuns.delete(signal.threadId);
      return yield* dispatchLoopAction({
        threadId: signal.threadId,
        turnKey,
        action: "block",
        reason: signalTag.reason,
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

  // A restart drops the in-flight turn but not the persisted `running` loop,
  // so sweep once at boot: every stale running loop either continues or
  // settles here, and none is left wedged waiting for an event that already
  // fired.
  const sweep = Effect.fn("GoalLoopReactor.sweep")(function* () {
    const snapshot = yield* snapshots.getShellSnapshot();
    yield* Effect.forEach(
      snapshot.threads.filter(
        (thread) => thread.goalLoop?.state === "running" && canDriveGoalLoop(thread),
      ),
      (thread) => worker.enqueue({ threadId: thread.id, turnId: null }),
      { discard: true },
    );
  });

  const start: GoalLoopReactor["Service"]["start"] = Effect.fn("GoalLoopReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* sweep().pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("goal loop reactor boot sweep failed", {
                    cause: Cause.pretty(cause),
                  }),
            ),
          );
          yield* Stream.runForEach(engine.streamDomainEvents, (event: OrchestrationEvent) => {
            if (event.type === "thread.turn-diff-completed") {
              return worker.enqueue({
                threadId: event.payload.threadId,
                turnId: event.payload.turnId,
              });
            }
            // Resume and "continue anyway" have no turn to end, so the loop
            // update is their start signal. Only those two actions set
            // `resumed`; a freshly set goal waits for the user's first message.
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
            return Effect.void;
          });
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies GoalLoopReactor["Service"];
});

export const layer = Layer.effect(GoalLoopReactor, make);
