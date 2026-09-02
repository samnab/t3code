import { ProviderDriverKind, RuntimeTaskId, SubagentRunStatus, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSubagentRunRepositoryLive } from "./ProjectionSubagentRuns.ts";
import Migration046 from "../Migrations/046_ProjectionSubagentTranscripts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionSubagentRunRepository } from "../Services/ProjectionSubagentRuns.ts";

// Apply 046 directly so this focused repository test stays isolated from the
// full migration manifest.
const withMigration046 = Layer.effectDiscard(Migration046);

const layer = it.layer(
  ProjectionSubagentRunRepositoryLive.pipe(
    Layer.provideMerge(withMigration046),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
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
        runBirth: null,
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

  it.effect("interrupts queued, active, and cancelling once and preserves terminal rows", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const reserve = (id: string, minute: number) =>
        repository.reserveRunNumber({
          runId: RuntimeTaskId.make(id),
          allocatedAt: at(minute),
          ownerId: null,
          ownerEpoch: `epoch-${id}`,
          nativeRunId: "sa-1",
          activationId: null,
        });
      const startRow = (
        id: string,
        runNumber: number,
        minute: number,
        status: SubagentRunStatus,
        terminalAt: string | null,
      ) =>
        repository.insertStart({
          runId: RuntimeTaskId.make(id),
          runNumber,
          threadId: ThreadId.make("thread-inventory"),
          parentRunId: null,
          runtimeFamily: "pi-manager",
          harness: null,
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: null,
          model: null,
          effort: null,
          title: null,
          summary: null,
          status,
          terminalReason: null,
          controlAvailability: "read-only",
          historyAvailability: "summary-only",
          capabilities: { steer: false, cancel: false, resume: false },
          createdAt: at(minute),
          updatedAt: at(minute),
          terminalAt,
          runBirth: null,
          ownerId: null,
          ownerEpoch: "reserved",
          nativeRunId: null,
          activationId: null,
          firstEventSequence: minute,
          lastEventSequence: minute,
        });

      const queuedNumber = yield* reserve("opaque-queued", 30);
      yield* startRow("opaque-queued", queuedNumber, 30, "queued", null);
      const cancellingNumber = yield* reserve("opaque-cancelling", 31);
      yield* startRow("opaque-cancelling", cancellingNumber, 31, "cancelling", null);
      const doneNumber = yield* reserve("opaque-done", 32);
      yield* startRow("opaque-done", doneNumber, 32, "done", at(32));
      const priorInterruptedNumber = yield* reserve("opaque-prior-interrupted", 33);
      yield* startRow(
        "opaque-prior-interrupted",
        priorInterruptedNumber,
        33,
        "interrupted",
        at(33),
      );

      assert.strictEqual(yield* repository.interruptNonResumable({ interruptedAt: at(40) }), 2);
      assert.strictEqual(yield* repository.interruptNonResumable({ interruptedAt: at(41) }), 0);

      const statusOf = (id: string) =>
        Effect.map(repository.getByRunId({ runId: RuntimeTaskId.make(id) }), (run) => run?.status);
      assert.strictEqual(yield* statusOf("opaque-queued"), "interrupted");
      assert.strictEqual(yield* statusOf("opaque-cancelling"), "interrupted");
      assert.strictEqual(yield* statusOf("opaque-done"), "done");
      const prior = yield* repository.getByRunId({
        runId: RuntimeTaskId.make("opaque-prior-interrupted"),
      });
      assert.strictEqual(prior?.status, "interrupted");
      assert.strictEqual(prior?.terminalReason, null);
      assert.strictEqual(prior?.terminalAt, at(33));
    }),
  );

  it.effect("a failed row write leaves a gap without reusing the reserved number", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const failedId = RuntimeTaskId.make("opaque-write-failure");
      const failedNumber = yield* repository.reserveRunNumber({
        runId: failedId,
        allocatedAt: at(50),
        ownerId: null,
        ownerEpoch: "epoch-failure",
        nativeRunId: "sa-2",
        activationId: null,
      });

      // A terminal status without a terminal timestamp violates the table's
      // CHECK: the write fails atomically, leaving no partial row.
      yield* repository
        .insertStart({
          runId: failedId,
          runNumber: failedNumber,
          threadId: ThreadId.make("thread-inventory"),
          parentRunId: null,
          runtimeFamily: "pi-manager",
          harness: null,
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: null,
          model: null,
          effort: null,
          title: null,
          summary: null,
          status: "done",
          terminalReason: null,
          controlAvailability: "read-only",
          historyAvailability: "summary-only",
          capabilities: { steer: false, cancel: false, resume: false },
          createdAt: at(50),
          updatedAt: at(50),
          terminalAt: null,
          runBirth: null,
          ownerId: null,
          ownerEpoch: "reserved",
          nativeRunId: null,
          activationId: null,
          firstEventSequence: 50,
          lastEventSequence: 50,
        })
        .pipe(Effect.flip);

      assert.strictEqual(yield* repository.getByRunId({ runId: failedId }), null);
      const nextNumber = yield* repository.reserveRunNumber({
        runId: RuntimeTaskId.make("opaque-after-failure"),
        allocatedAt: at(51),
        ownerId: null,
        ownerEpoch: "epoch-after",
        nativeRunId: "sa-3",
        activationId: null,
      });
      assert.ok(nextNumber > failedNumber);
    }),
  );

  it.effect(
    "persists run-birth, keeps inventory body-free, and advances the watermark monotonically",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionSubagentRunRepository;
        const runId = RuntimeTaskId.make("opaque-binding-run");
        const runNumber = yield* repository.reserveRunNumber({
          runId,
          allocatedAt: at(60),
          ownerId: "manager-binding",
          ownerEpoch: "epoch-binding",
          nativeRunId: "sa-9",
          activationId: "act-9",
        });
        yield* repository.insertStart({
          runId,
          runNumber,
          threadId: ThreadId.make("thread-binding"),
          parentRunId: null,
          runtimeFamily: "pi-manager",
          harness: "pi",
          provider: ProviderDriverKind.make("pi"),
          providerInstanceId: null,
          model: null,
          effort: null,
          title: null,
          summary: null,
          status: "active",
          terminalReason: null,
          controlAvailability: "owner-routed",
          historyAvailability: "durable",
          capabilities: { steer: true, cancel: true, resume: false },
          createdAt: at(60),
          updatedAt: at(60),
          terminalAt: null,
          runBirth: "rbaaaaaaaaaaaaaaaaaaaaaa1",
          ownerId: null,
          ownerEpoch: "reserved",
          nativeRunId: null,
          activationId: null,
          firstEventSequence: 60,
          lastEventSequence: 60,
        });

        const binding = yield* repository.getRunBinding({ runId });
        assert.deepStrictEqual(binding, {
          runId,
          threadId: ThreadId.make("thread-binding"),
          managerId: "manager-binding",
          managerRunId: "sa-9",
          activationId: "act-9",
          runBirth: "rbaaaaaaaaaaaaaaaaaaaaaa1",
          historyAvailability: "durable",
          lastTranscriptSequence: null,
        });

        // The public inventory row stays free of binding metadata.
        const publicRun = yield* repository.getByRunId({ runId });
        assert.strictEqual("runBirth" in (publicRun ?? {}), false);

        yield* repository.advanceTranscriptWatermark({
          runId,
          lastTranscriptSequence: 7,
        });
        yield* repository.advanceTranscriptWatermark({
          runId,
          lastTranscriptSequence: 3,
        });
        assert.strictEqual((yield* repository.getRunBinding({ runId }))?.lastTranscriptSequence, 7);

        assert.strictEqual(
          yield* repository.getRunBinding({ runId: RuntimeTaskId.make("opaque-unknown") }),
          null,
        );
      }),
  );
});
