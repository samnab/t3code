import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type ProjectSchedule,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerActivation } from "../serverActivation.ts";
import * as ScheduleReactor from "./ScheduleReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

// The server-start floor: every schedule's first due instant is computed
// strictly after this instant. The spaced tick fires exactly one minute
// later, so the schedule is due then and the sweep's now is that instant.
const NOW = "2026-08-28T12:00:00.000Z";
const DUE = "2026-08-28T12:01:00.000Z";
const FIRED_AT = DUE;
const THREAD_ID = ThreadId.make("schedule-sch-1-2026-08-28T12-01-00-000Z");
const PROJECT_ID = ProjectId.make("sched-project");

type ScheduleCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.create" | "thread.turn.start" | "project.schedule.mark-fired" }
>;

function makeSchedule(overrides: Partial<ProjectSchedule> = {}): ProjectSchedule {
  return {
    id: "sch-1",
    name: "Hourly sync",
    prompt: "Summarize open work",
    cadence: { kind: "hourly", minute: 1 },
    timeZone: "UTC",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    enabled: true,
    ...overrides,
  };
}

function makeProject(schedules: ReadonlyArray<ProjectSchedule>): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Schedules",
    workspaceRoot: "/workspace/schedules",
    defaultModelSelection: null,
    scripts: [],
    schedules: [...schedules],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: NOW,
  };
}

interface HarnessOptions {
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
}

const makeHarness = Effect.fn("makeScheduleHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const projects = yield* Ref.make(options.projects);
  const projectReads = yield* Queue.unbounded<void>();
  const commands = yield* Ref.make<ReadonlyArray<ScheduleCommand>>([]);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
    if (
      command.type === "thread.create" ||
      command.type === "thread.turn.start" ||
      command.type === "project.schedule.mark-fired"
    ) {
      return Ref.update(commands, (recorded) => [...recorded, command]).pipe(
        Effect.as({ sequence: 1 }),
      );
    }
    return Effect.die(new Error(`Unexpected command: ${command.type}`));
  };

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getProjectShells: () =>
        Queue.offer(projectReads, undefined).pipe(Effect.andThen(Ref.get(projects))),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
  );

  return {
    activation,
    projects,
    projectReads,
    commands,
    layer: ScheduleReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const startAndSweep = Effect.fn("startScheduleHarness")(function* (fixture: Harness) {
  const reactor = yield* ScheduleReactor.ScheduleReactor;
  yield* reactor.start();
  yield* Deferred.succeed(fixture.activation, undefined);
  yield* Queue.take(fixture.projectReads);
  yield* reactor.drain;
  return reactor;
});

const sweepAgain = Effect.fn("sweepScheduleAgain")(function* (
  fixture: Harness,
  reactor: ScheduleReactor.ScheduleReactor["Service"],
) {
  yield* TestClock.adjust("1 minute");
  yield* Queue.take(fixture.projectReads);
  yield* reactor.drain;
});

describe("ScheduleReactor", () => {
  it.effect("fires a due schedule into a new thread and marks it fired", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({ projects: [makeProject([makeSchedule()])] });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          // The due time is still ahead of the server-start floor.
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);

          yield* sweepAgain(fixture, reactor);
          const commands = yield* Ref.get(fixture.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            ["thread.create", "thread.turn.start", "project.schedule.mark-fired"],
          );
          assert.deepStrictEqual(commands, [
            {
              type: "thread.create",
              commandId: CommandId.make(`server:schedule-create:sch-1:${DUE}`),
              threadId: THREAD_ID,
              projectId: PROJECT_ID,
              title: "Hourly sync",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: FIRED_AT,
            },
            {
              type: "thread.turn.start",
              commandId: CommandId.make(`server:schedule-turn:sch-1:${DUE}`),
              threadId: THREAD_ID,
              message: {
                messageId: MessageId.make(`schedule:sch-1:${DUE}`),
                role: "user",
                text: "Summarize open work",
                attachments: [],
                origin: "schedule",
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              onlyIfIdle: true,
              createdAt: FIRED_AT,
            },
            {
              type: "project.schedule.mark-fired",
              commandId: CommandId.make(`server:schedule-fired:sch-1:${DUE}`),
              projectId: PROJECT_ID,
              scheduleId: "sch-1",
              threadId: THREAD_ID,
              firedAt: FIRED_AT,
            },
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a replayed tick re-sends identical command ids", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({ projects: [makeProject([makeSchedule()])] });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* sweepAgain(fixture, reactor);
          const first = (yield* Ref.get(fixture.commands)).map((command) => command.commandId);
          assert.strictEqual(first.length, 3);

          // The read model still shows lastFiredAt absent, as a tick replayed
          // before the projection caught up would.
          yield* sweepAgain(fixture, reactor);
          const commands = yield* Ref.get(fixture.commands);
          assert.strictEqual(commands.length, 6);
          assert.deepStrictEqual(
            commands.slice(3).map((command) => command.commandId),
            first,
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a schedule fired just now does not fire again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          projects: [makeProject([makeSchedule({ lastFiredAt: DUE })])],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* sweepAgain(fixture, reactor);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a disabled schedule never fires", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          projects: [makeProject([makeSchedule({ enabled: false })])],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* sweepAgain(fixture, reactor);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("an invalid time zone does not block a sibling schedule", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          projects: [
            makeProject([
              makeSchedule({ id: "sch-bad", timeZone: "Mars/Olympus" }),
              makeSchedule({ id: "sch-good" }),
            ]),
          ],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* startAndSweep(fixture);
          yield* sweepAgain(fixture, reactor);
          const commands = yield* Ref.get(fixture.commands);
          assert.deepStrictEqual(
            commands.map((command) => command.type),
            ["thread.create", "thread.turn.start", "project.schedule.mark-fired"],
          );
          for (const command of commands) {
            const id = `${command.commandId}`;
            assert.include(id, "sch-good");
            assert.notInclude(id, "sch-bad");
          }
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
