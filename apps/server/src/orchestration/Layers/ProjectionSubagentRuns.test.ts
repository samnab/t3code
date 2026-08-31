import { CommandId, CorrelationId, EventId, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import {
  ORCHESTRATION_PROJECTOR_NAMES,
  OrchestrationProjectionPipelineLive,
} from "./ProjectionPipeline.ts";

const layer = it.layer(
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "subagent-runs-" })),
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
});
