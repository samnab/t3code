import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectSchedule,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);

const schedule = (id: string): ProjectSchedule => ({
  id,
  name: "Nightly build",
  prompt: "run the nightly build",
  cadence: { kind: "daily", time: "08:00" },
  timeZone: "UTC",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  enabled: true,
});

const withProject = Effect.gen(function* () {
  return yield* projectEvent(createEmptyReadModel("2026-01-01T00:00:00.000Z"), {
    sequence: 1,
    eventId: asEventId("evt-project-create-schedules"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-schedules"),
    type: "project.created",
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make("cmd-project-create-schedules"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project-create-schedules"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-schedules"),
      title: "Schedules",
      workspaceRoot: "/tmp/schedules",
      defaultModelSelection: null,
      scripts: [],
      schedules: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
});
it.layer(NodeServices.layer)("decider project schedules", (it) => {
  const now = "2026-01-01T00:00:00.000Z";
  const readModel = createEmptyReadModel(now);

  it.effect("emits empty schedules on project.create", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-schedules"),
          projectId: asProjectId("project-schedules"),
          title: "Schedules",
          workspaceRoot: "/tmp/schedules",
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { schedules: unknown[] }).schedules).toEqual([]);
    }),
  );

  it.effect("propagates schedules in project.meta.update payload", () =>
    Effect.gen(function* () {
      const initial = createEmptyReadModel(now);
      const withProject = yield* projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-schedules"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-schedules"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-schedules"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-schedules"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-schedules"),
          title: "Schedules",
          workspaceRoot: "/tmp/schedules",
          defaultModelSelection: null,
          scripts: [],
          schedules: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const schedules = [schedule("nightly-build"), schedule("weekly-report")];
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-schedules"),
          projectId: asProjectId("project-schedules"),
          schedules,
        },
        readModel: withProject,
      });

      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { schedules?: unknown[] }).schedules).toEqual(schedules);
    }),
  );

  it.effect("rejects duplicate schedule ids", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-duplicate-schedule"),
            projectId: asProjectId("project-schedules"),
            schedules: [schedule("dup"), schedule("dup")],
          },
          readModel: yield* withProject,
        }),
      );
      expect(failure).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      expect(failure.message).toContain("more than once");
    }),
  );

  it.effect("marks a fired schedule and updates only that schedule", () =>
    Effect.gen(function* () {
      const withSchedules = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-set-schedules"),
          projectId: asProjectId("project-schedules"),
          schedules: [schedule("nightly-build"), schedule("weekly-report")],
        },
        readModel: yield* withProject,
      });
      const setEvent = Array.isArray(withSchedules) ? withSchedules[0] : withSchedules;
      const readModel = yield* projectEvent(yield* withProject, {
        sequence: 2,
        ...setEvent,
        payload: setEvent.payload,
      });

      const firedAt = "2026-01-02T08:00:00.000Z";
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.schedule.mark-fired",
          commandId: CommandId.make("cmd-schedule-mark-fired"),
          projectId: asProjectId("project-schedules"),
          scheduleId: "nightly-build",
          threadId: ThreadId.make("thread-schedules"),
          firedAt,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("project.schedule-fired");

      const nextReadModel = yield* projectEvent(readModel, {
        sequence: 3,
        eventId: asEventId("evt-schedule-fired"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-schedules"),
        type: "project.schedule-fired",
        occurredAt: firedAt,
        commandId: CommandId.make("cmd-schedule-mark-fired"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-schedule-mark-fired"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-schedules"),
          scheduleId: "nightly-build",
          threadId: ThreadId.make("thread-schedules"),
          firedAt,
        },
      });

      const schedules = nextReadModel.projects[0]?.schedules ?? [];
      expect(schedules).toHaveLength(2);
      expect(schedules[0]?.lastFiredAt).toBe(firedAt);
      expect(schedules[1]?.lastFiredAt).toBeUndefined();
    }),
  );
});
