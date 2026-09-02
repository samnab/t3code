import { CommandId, CorrelationId, EventId, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import Migration046 from "../../persistence/Migrations/046_ProjectionSubagentTranscripts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionSubagentRunRepository } from "../../persistence/Services/ProjectionSubagentRuns.ts";
import { ProjectionSubagentTranscriptStore } from "../../persistence/Services/ProjectionSubagentTranscripts.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "subagent-runs-" })),
    // Apply 046 directly so this focused projector test stays isolated from
    // the full migration manifest.
    Layer.provideMerge(Layer.effectDiscard(Migration046)),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("subagent run projection", (it) => {
  it.effect("replays the reserved identity and keeps the first terminal state", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-subagent-projection");
      const runId = RuntimeTaskId.make("opaque-projected-run");
      const startedAt = "2026-06-15T01:00:00.000Z";
      const reservation = yield* sql<{ readonly runNumber: number }>`
        INSERT INTO subagent_run_number_reservations (
          run_id,
          allocated_at,
          owner_id,
          owner_epoch,
          native_run_id,
          activation_id
        ) VALUES (
          ${runId},
          ${startedAt},
          'manager-one',
          'epoch-one',
          'sa-1',
          'activation-one'
        )
        RETURNING run_number AS "runNumber"
      `;
      const runNumber = reservation[0]!.runNumber;

      const appendActivity = (
        sequence: number,
        kind: "task.started" | "task.updated" | "task.completed",
        status: "active" | "done",
      ) => {
        const occurredAt = `2026-06-15T01:0${sequence}:00.000Z`;
        const commandId = CommandId.make(`cmd-subagent-${sequence}`);
        return eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make(`event-subagent-${sequence}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId,
          causationEventId: null,
          correlationId: CorrelationId.make(commandId),
          metadata: {},
          payload: {
            threadId,
            activity: {
              id: EventId.make(`activity-subagent-${sequence}`),
              tone: "info",
              kind,
              summary: kind === "task.started" ? "Started map auth" : "Mapped auth",
              payload: {
                taskId: runId,
                title: "Map auth",
                summary: "Mapped auth",
                subagentRun: {
                  runId,
                  runNumber,
                  runtimeFamily: "pi-manager",
                  harness: "pi",
                  provider: "pi",
                  status,
                  ...(status === "done" ? { terminalReason: "native-completed" } : {}),
                  controlAvailability: status === "done" ? "read-only" : "owner-routed",
                  historyAvailability: "summary-only",
                  capabilities: { steer: true, cancel: true, resume: false },
                  startedAt,
                },
              },
              turnId: null,
              createdAt: occurredAt,
            },
          },
        });
      };

      yield* appendActivity(1, "task.started", "active");
      yield* pipeline.bootstrap;

      const projected = () => sql<{
        readonly runNumber: number;
        readonly status: string;
        readonly terminalAt: string | null;
        readonly ownerEpoch: string;
      }>`
        SELECT
          run_number AS "runNumber",
          status,
          terminal_at AS "terminalAt",
          owner_epoch AS "ownerEpoch"
        FROM projection_subagent_runs
        WHERE run_id = ${runId}
      `;
      assert.deepStrictEqual(yield* projected(), [
        { runNumber, status: "active", terminalAt: null, ownerEpoch: "epoch-one" },
      ]);

      yield* sql`DELETE FROM projection_subagent_runs WHERE run_id = ${runId}`;
      yield* sql`
        UPDATE projection_state
        SET last_applied_sequence = 0
        WHERE projector = ${ORCHESTRATION_PROJECTOR_NAMES.subagentRuns}
      `;
      yield* pipeline.bootstrap;
      assert.deepStrictEqual(yield* projected(), [
        { runNumber, status: "active", terminalAt: null, ownerEpoch: "epoch-one" },
      ]);

      yield* appendActivity(2, "task.completed", "done");
      yield* appendActivity(3, "task.updated", "active");
      yield* pipeline.bootstrap;
      assert.deepStrictEqual(yield* projected(), [
        {
          runNumber,
          status: "done",
          terminalAt: "2026-06-15T01:02:00.000Z",
          ownerEpoch: "epoch-one",
        },
      ]);
    }),
  );

  it.effect("numbers runs globally across threads and persists the opaque parent run", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const sql = yield* SqlClient.SqlClient;

      const reserve = (runId: string, ownerEpoch: string) => sql<{ readonly runNumber: number }>`
        INSERT INTO subagent_run_number_reservations (
          run_id, allocated_at, owner_id, owner_epoch, native_run_id, activation_id
        ) VALUES (
          ${runId}, '2026-06-15T02:00:00.000Z', NULL, ${ownerEpoch}, 'sa-1', NULL
        )
        RETURNING run_number AS "runNumber"
      `;

      const appendStart = (
        sequence: number,
        threadId: string,
        runId: string,
        runNumber: number,
        parentRunId?: string,
      ) => {
        const occurredAt = `2026-06-15T02:0${sequence}:00.000Z`;
        const commandId = CommandId.make(`cmd-cross-${sequence}`);
        return eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make(`event-cross-${sequence}`),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(threadId),
          occurredAt,
          commandId,
          causationEventId: null,
          correlationId: CorrelationId.make(commandId),
          metadata: {},
          payload: {
            threadId: ThreadId.make(threadId),
            activity: {
              id: EventId.make(`activity-cross-${sequence}`),
              tone: "info",
              kind: "task.started",
              summary: "Started run",
              payload: {
                taskId: runId,
                subagentRun: {
                  runId,
                  runNumber,
                  ...(parentRunId !== undefined ? { parentRunId } : {}),
                  runtimeFamily: "pi-stock",
                  harness: "pi",
                  provider: "pi",
                  status: "active",
                  controlAvailability: "unsupported",
                  historyAvailability: "summary-only",
                  capabilities: { steer: false, cancel: false, resume: false },
                  startedAt: occurredAt,
                },
              },
              turnId: null,
              createdAt: occurredAt,
            },
          },
        });
      };

      const threadOne = "thread-cross-one";
      const threadTwo = "thread-cross-two";
      const rootId = "opaque-cross-root";
      const childId = "opaque-cross-child";
      const soloId = "opaque-cross-solo";
      const rootNumber = (yield* reserve(rootId, "epoch-one"))[0]!.runNumber;
      const childNumber = (yield* reserve(childId, "epoch-one"))[0]!.runNumber;
      const soloNumber = (yield* reserve(soloId, "epoch-two"))[0]!.runNumber;

      yield* appendStart(1, threadOne, rootId, rootNumber);
      yield* appendStart(2, threadOne, childId, childNumber, rootId);
      yield* appendStart(3, threadTwo, soloId, soloNumber);
      yield* pipeline.bootstrap;

      const rows = yield* sql<{
        readonly runId: string;
        readonly runNumber: number;
        readonly threadId: string;
        readonly parentRunId: string | null;
      }>`
        SELECT run_id AS "runId", run_number AS "runNumber",
          thread_id AS "threadId", parent_run_id AS "parentRunId"
        FROM projection_subagent_runs
        WHERE run_id IN (${rootId}, ${childId}, ${soloId})
        ORDER BY run_number ASC
      `;
      assert.deepStrictEqual(rows, [
        {
          runId: rootId,
          runNumber: rootNumber,
          threadId: threadOne,
          parentRunId: null,
        },
        {
          runId: childId,
          runNumber: childNumber,
          threadId: threadOne,
          parentRunId: rootId,
        },
        {
          runId: soloId,
          runNumber: soloNumber,
          threadId: threadTwo,
          parentRunId: null,
        },
      ]);
      assert.ok(childNumber > rootNumber);
      assert.ok(soloNumber > childNumber);
    }),
  );

  it.effect("treats a reused native id after restart as a new run and freezes the old row", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const repository = yield* ProjectionSubagentRunRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread-reuse";

      const reserve = (runId: string, ownerEpoch: string) => sql<{ readonly runNumber: number }>`
        INSERT INTO subagent_run_number_reservations (
          run_id, allocated_at, owner_id, owner_epoch, native_run_id, activation_id
        ) VALUES (
          ${runId}, '2026-06-15T03:00:00.000Z', NULL, ${ownerEpoch}, 'sa-1', NULL
        )
        RETURNING run_number AS "runNumber"
      `;
      const appendStart = (sequence: number, runId: string, runNumber: number, epoch: string) => {
        const occurredAt = `2026-06-15T03:0${sequence}:00.000Z`;
        const commandId = CommandId.make(`cmd-reuse-${sequence}`);
        return eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make(`event-reuse-${sequence}`),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(threadId),
          occurredAt,
          commandId,
          causationEventId: null,
          correlationId: CorrelationId.make(commandId),
          metadata: {},
          payload: {
            threadId: ThreadId.make(threadId),
            activity: {
              id: EventId.make(`activity-reuse-${sequence}`),
              tone: "info",
              kind: "task.started",
              summary: "Started run",
              payload: {
                taskId: runId,
                subagentRun: {
                  runId,
                  runNumber,
                  runtimeFamily: "pi-stock",
                  harness: "pi",
                  provider: "pi",
                  ownerEpoch: epoch,
                  nativeRunId: "sa-1",
                  status: "active",
                  controlAvailability: "unsupported",
                  historyAvailability: "summary-only",
                  capabilities: { steer: false, cancel: false, resume: false },
                  startedAt: occurredAt,
                },
              },
              turnId: null,
              createdAt: occurredAt,
            },
          },
        });
      };
      const appendLateDone = (sequence: number, runId: string) => {
        const occurredAt = `2026-06-15T03:0${sequence}:00.000Z`;
        const commandId = CommandId.make(`cmd-reuse-${sequence}`);
        return eventStore.append({
          type: "thread.activity-appended",
          eventId: EventId.make(`event-reuse-${sequence}`),
          aggregateKind: "thread",
          aggregateId: ThreadId.make(threadId),
          occurredAt,
          commandId,
          causationEventId: null,
          correlationId: CorrelationId.make(commandId),
          metadata: {},
          payload: {
            threadId: ThreadId.make(threadId),
            activity: {
              id: EventId.make(`activity-reuse-${sequence}`),
              tone: "info",
              kind: "task.completed",
              summary: "Late native done",
              payload: {
                taskId: runId,
                subagentRun: {
                  runId,
                  runtimeFamily: "pi-stock",
                  harness: "pi",
                  provider: "pi",
                  status: "done",
                  terminalReason: "native-completed",
                  controlAvailability: "unsupported",
                  historyAvailability: "summary-only",
                  capabilities: { steer: false, cancel: false, resume: false },
                  startedAt: occurredAt,
                },
              },
              turnId: null,
              createdAt: occurredAt,
            },
          },
        });
      };

      const oldId = "opaque-reuse-old";
      const newId = "opaque-reuse-new";
      const oldNumber = (yield* reserve(oldId, "epoch-before-restart"))[0]!.runNumber;
      yield* appendStart(1, oldId, oldNumber, "epoch-before-restart");
      yield* pipeline.bootstrap;
      const rowsFor = (first: string, second: string) => sql<{
        readonly runId: string;
        readonly runNumber: number;
        readonly status: string;
        readonly terminalReason: string | null;
        readonly ownerEpoch: string;
        readonly nativeRunId: string | null;
      }>`
        SELECT run_id AS "runId", run_number AS "runNumber", status,
          terminal_reason AS "terminalReason", owner_epoch AS "ownerEpoch",
          native_run_id AS "nativeRunId"
        FROM projection_subagent_runs
        WHERE run_id IN (${first}, ${second})
        ORDER BY run_number ASC
      `;
      yield* repository.interruptNonResumable({ interruptedAt: "2026-06-15T03:30:00.000Z" });
      // Repeated reconciliation is a no-op on the now-terminal row.
      yield* repository.interruptNonResumable({ interruptedAt: "2026-06-15T03:35:00.000Z" });

      const newNumber = (yield* reserve(newId, "epoch-after-restart"))[0]!.runNumber;
      yield* appendStart(2, newId, newNumber, "epoch-after-restart");
      // A late native completion for the interrupted run must not unfreeze it.
      yield* appendLateDone(3, oldId);
      yield* pipeline.bootstrap;

      const rows = yield* rowsFor(oldId, newId);
      assert.deepStrictEqual(rows, [
        {
          runId: oldId,
          runNumber: oldNumber,
          status: "interrupted",
          terminalReason: "server-restart",
          ownerEpoch: "epoch-before-restart",
          nativeRunId: "sa-1",
        },
        {
          runId: newId,
          runNumber: newNumber,
          status: "active",
          terminalReason: null,
          ownerEpoch: "epoch-after-restart",
          nativeRunId: "sa-1",
        },
      ]);
      assert.ok(newNumber > oldNumber);
    }),
  );

  it.effect(
    "persists run-birth, clamps unbacked durable history, and signals the durable start",
    () =>
      Effect.gen(function* () {
        const eventStore = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const transcriptStore = yield* ProjectionSubagentTranscriptStore;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-runbirth-projection");
        const startedAt = "2026-06-15T03:00:00.000Z";
        const runBirth = `rb${"d".repeat(22)}`;

        const seed = (runId: string) =>
          sql<{ readonly runNumber: number }>`
          INSERT INTO subagent_run_number_reservations (
            run_id, allocated_at, owner_id, owner_epoch, native_run_id, activation_id
          ) VALUES (
            ${runId}, ${startedAt}, 'manager-one', 'epoch-one', 'sa-1', 'act-1'
          )
          RETURNING run_number AS "runNumber"
        `;

        const appendStart = (
          sequence: number,
          runId: string,
          runNumber: number,
          evidenceOverrides: Record<string, unknown>,
        ) => {
          const occurredAt = `2026-06-15T03:0${sequence}:00.000Z`;
          const commandId = CommandId.make(`cmd-runbirth-${sequence}`);
          return eventStore.append({
            type: "thread.activity-appended",
            eventId: EventId.make(`event-runbirth-${sequence}`),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId,
            causationEventId: null,
            correlationId: CorrelationId.make(commandId),
            metadata: {},
            payload: {
              threadId,
              activity: {
                id: EventId.make(`activity-runbirth-${sequence}`),
                tone: "info",
                kind: "task.started",
                summary: "Started run",
                payload: {
                  taskId: runId,
                  subagentRun: {
                    runId,
                    runNumber,
                    runtimeFamily: "pi-manager",
                    harness: "pi",
                    provider: "pi",
                    status: "active",
                    controlAvailability: "owner-routed",
                    historyAvailability: "durable",
                    capabilities: { steer: true, cancel: true, resume: false },
                    startedAt,
                    ...evidenceOverrides,
                  },
                },
                turnId: null,
                createdAt: occurredAt,
              },
            },
          });
        };

        const boundId = "opaque-runbirth-bound";
        const boundNumber = (yield* seed(boundId))[0]!.runNumber;
        const unbackedId = "opaque-runbirth-unbacked";
        const unbackedNumber = (yield* seed(unbackedId))[0]!.runNumber;

        yield* appendStart(1, boundId, boundNumber, { runBirth, upsertSequence: 4 });
        yield* appendStart(2, unbackedId, unbackedNumber, {});
        yield* pipeline.bootstrap;

        const rows = yield* sql<{
          readonly runId: string;
          readonly runBirth: string | null;
          readonly historyAvailability: string;
        }>`
        SELECT run_id AS "runId", run_birth AS "runBirth",
          history_availability AS "historyAvailability"
        FROM projection_subagent_runs
        WHERE run_id IN (${boundId}, ${unbackedId})
      `;
        assert.deepStrictEqual(rows, [
          {
            runId: boundId,
            runBirth,
            historyAvailability: "durable",
          },
          {
            runId: unbackedId,
            runBirth: null,
            // Truthful history: without binding evidence a durable claim clamps
            // to summary-only — stock managers never gain transcript history.
            historyAvailability: "summary-only",
          },
        ]);

        // The durable start receipt fired for the bound run only.
        assert.strictEqual(
          yield* transcriptStore.awaitStartCommitted({
            runId: RuntimeTaskId.make(boundId),
            timeoutMs: 50,
          }),
          true,
        );
      }),
  );
});
