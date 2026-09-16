/**
 * ScheduleReactor — fires project schedules into new threads.
 *
 * Every minute it sweeps the project shells in the projection and, for each
 * enabled schedule whose next occurrence (computed by `nextFireAfter` from
 * the schedule's `lastFiredAt`, or from server start on first sight) is due,
 * creates a thread in the project and starts one turn with the schedule's
 * prompt. Runs with no client connected.
 *
 * Missed runs collapse: the fire is recorded with the sweep's `now`, never
 * the due instant, so a laptop asleep for three days wakes to one fire per
 * schedule instead of replaying every missed occurrence. Occurrences that
 * passed before this server process started never fire at all — server start
 * is the catch-up floor.
 *
 * Idempotency: all three commands of a fire are keyed on
 * `scheduleId + dueKey`, so a tick that replays before the projection caught
 * up (or a crash between the three dispatches) re-sends identical commandIds
 * and the engine's command receipts collapse them onto the accepted ones.
 *
 * @module ScheduleReactor
 */
// @effect-diagnostics globalDate:off -- Occurrence math is pure wall-clock arithmetic over Intl and JS Date, matching projectSchedules.ts.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationProjectShell,
  type ProjectSchedule,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { nextFireAfter } from "@t3tools/shared/projectSchedules";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Next occurrence strictly after the schedule's `lastFiredAt` (or `floorMs`),
 * or null when the time zone is invalid. Plain on purpose: schedule math is
 * pure wall-clock arithmetic over Intl and JS Date, like projectSchedules.ts.
 */
function nextDue(schedule: ProjectSchedule, floorMs: number): Date | null {
  try {
    const afterMs = schedule.lastFiredAt ? Date.parse(schedule.lastFiredAt) : floorMs;
    return nextFireAfter(schedule.cadence, schedule.timeZone, new Date(afterMs));
  } catch {
    return null;
  }
}

export class ScheduleReactor extends Context.Service<
  ScheduleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ScheduleReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  // Server start is the catch-up floor: `nextFireAfter` runs from here on
  // first sight, so a newly seen schedule never fires for the past.
  const floorMs = DateTime.toEpochMillis(yield* DateTime.now);

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  const fire = Effect.fn("ScheduleReactor.fire")(function* (
    project: OrchestrationProjectShell,
    schedule: ProjectSchedule,
    due: Date,
    nowIso: string,
  ) {
    const dueKey = due.toISOString();
    const key = `${schedule.id}:${dueKey}`;
    // Deterministic thread id so a replayed tick collapses onto the same
    // thread rather than minting a duplicate.
    const threadId = ThreadId.make(`schedule-${schedule.id}-${dueKey.replace(/[:.]/g, "-")}`);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`server:schedule-create:${key}`),
      threadId,
      projectId: project.id,
      title: schedule.name,
      modelSelection: schedule.modelSelection,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: nowIso,
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:schedule-turn:${key}`),
      threadId,
      message: {
        messageId: MessageId.make(`schedule:${key}`),
        role: "user",
        text: schedule.prompt,
        attachments: [],
        origin: "schedule",
      },
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      onlyIfIdle: true,
      createdAt: nowIso,
    });
    // firedAt is now, not due: recording the wake-up instant means a schedule
    // overdue by three days is marked fired once, not three days' worth.
    yield* engine.dispatch({
      type: "project.schedule.mark-fired",
      commandId: CommandId.make(`server:schedule-fired:${key}`),
      projectId: project.id,
      scheduleId: schedule.id,
      threadId,
      firedAt: nowIso,
    });
  });

  const sweep = Effect.fn("ScheduleReactor.sweep")(function* () {
    const projects = yield* snapshots.getProjectShells();
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);

    for (const project of projects) {
      for (const schedule of project.schedules) {
        if (!schedule.enabled) continue;
        const due = nextDue(schedule, floorMs);
        if (due === null) {
          yield* Effect.logWarning("schedule has an invalid time zone; skipping", {
            projectId: project.id,
            scheduleId: schedule.id,
          });
          continue;
        }
        if (due.getTime() > nowMs) continue;
        // At most one occurrence per schedule per sweep: `due` is the single
        // next instant after lastFiredAt, and mark-fired moves the cursor.
        yield* fire(project, schedule, due, nowIso).pipe(
          Effect.catchCause(
            logSkipped("schedule fire skipped", {
              projectId: project.id,
              scheduleId: schedule.id,
            }),
          ),
        );
      }
    }
  });

  const worker = yield* makeDrainableWorker(() =>
    sweep().pipe(Effect.catchCause(logSkipped("schedule sweep failed", {}))),
  );

  const start: ScheduleReactor["Service"]["start"] = Effect.fn("ScheduleReactor.start")(
    function* () {
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue(undefined);
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
      );
    },
  );

  return { start, drain: worker.drain } satisfies ScheduleReactor["Service"];
});

export const layer = Layer.effect(ScheduleReactor, make);
