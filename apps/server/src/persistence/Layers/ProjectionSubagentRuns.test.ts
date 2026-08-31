import { ProviderDriverKind, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSubagentRunRepositoryLive } from "./ProjectionSubagentRuns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionSubagentRunRepository } from "../Services/ProjectionSubagentRuns.ts";

const layer = it.layer(
  ProjectionSubagentRunRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const at = (minute: number) => `2026-06-15T00:${String(minute).padStart(2, "0")}:00.000Z`;

layer("ProjectionSubagentRunRepository", (it) => {
  it.effect("allocates globally without reusing committed reservations", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const sql = yield* SqlClient.SqlClient;
      const reserve = (id: string, minute: number) =>
        repository.reserveRunNumber({
          runId: RuntimeTaskId.make(id),
          allocatedAt: at(minute),
          ownerId: null,
          ownerEpoch: "epoch-a",
          nativeRunId: id,
          activationId: null,
        });

      const first = yield* reserve("opaque-a", 0);
      assert.strictEqual(yield* reserve("opaque-a", 1), first);

      const abandoned = yield* reserve("opaque-abandoned", 2);
      yield* sql`DELETE FROM subagent_run_number_reservations WHERE run_id = 'opaque-abandoned'`;
      const afterDeletion = yield* reserve("opaque-b", 3);
      assert.ok(afterDeletion > abandoned);

      const concurrent = yield* Effect.forEach(
        Array.from({ length: 12 }, (_, index) => `opaque-concurrent-${index}`),
        (id, index) => reserve(id, index + 4),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(new Set(concurrent).size, concurrent.length);
      assert.ok(Math.min(...concurrent) > afterDeletion);
    }),
  );

  it.effect("keeps reservation provenance private and interrupts live rows exactly once", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const sql = yield* SqlClient.SqlClient;
      const runId = RuntimeTaskId.make("opaque-lifecycle");
      const runNumber = yield* repository.reserveRunNumber({
        runId,
        allocatedAt: at(20),
        ownerId: "manager-one",
        ownerEpoch: "epoch-private",
        nativeRunId: "sa-1",
        activationId: "activation-one",
      });

      yield* repository.insertStart({
        runId,
        runNumber,
        threadId: ThreadId.make("thread-inventory"),
        parentRunId: null,
        runtimeFamily: "pi-manager",
        harness: "pi",
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: null,
        model: "zai/glm-5.3-flash",
        effort: null,
        title: "Map auth",
        summary: null,
        status: "active",
        terminalReason: null,
        controlAvailability: "owner-routed",
        historyAvailability: "summary-only",
        capabilities: { steer: true, cancel: true, resume: false },
        createdAt: at(20),
        updatedAt: at(20),
        terminalAt: null,
        ownerId: null,
        ownerEpoch: "ignored",
        nativeRunId: null,
        activationId: null,
        firstEventSequence: 20,
        lastEventSequence: 20,
      });

      const privateRows = yield* sql<{
        readonly ownerId: string | null;
        readonly ownerEpoch: string;
        readonly nativeRunId: string | null;
        readonly activationId: string | null;
      }>`
        SELECT
          owner_id AS "ownerId",
          owner_epoch AS "ownerEpoch",
          native_run_id AS "nativeRunId",
          activation_id AS "activationId"
        FROM projection_subagent_runs
        WHERE run_id = ${runId}
      `;
      assert.deepStrictEqual(privateRows[0], {
        ownerId: "manager-one",
        ownerEpoch: "epoch-private",
        nativeRunId: "sa-1",
        activationId: "activation-one",
      });

      assert.strictEqual(yield* repository.interruptNonResumable({ interruptedAt: at(21) }), 1);
      assert.strictEqual(yield* repository.interruptNonResumable({ interruptedAt: at(22) }), 0);
      assert.deepStrictEqual(yield* repository.getByRunId({ runId }), {
        runId,
        runNumber,
        threadId: ThreadId.make("thread-inventory"),
        parentRunId: null,
        runtimeFamily: "pi-manager",
        harness: "pi",
        provider: ProviderDriverKind.make("pi"),
        providerInstanceId: null,
        model: "zai/glm-5.3-flash",
        effort: null,
        title: "Map auth",
        summary: null,
        status: "interrupted",
        terminalReason: "server-restart",
        controlAvailability: "read-only",
        historyAvailability: "summary-only",
        capabilities: { steer: true, cancel: true, resume: false },
        createdAt: at(20),
        updatedAt: at(21),
        terminalAt: at(21),
      });
    }),
  );
});
