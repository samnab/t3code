import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { NativeChildRunRepositoryLive } from "../Layers/NativeChildRuns.ts";
import { runMigrations } from "../Migrations.ts";
import { NativeChildRun, NativeChildRunRepository } from "../Services/NativeChildRuns.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const testLayer = NativeChildRunRepositoryLive.pipe(Layer.provideMerge(sqlLayer));

it.layer(testLayer)("native child persistence", (it) => {
  it.effect("widens Agents inventory and reconciles a durable child after restart", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* NativeChildRunRepository;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql`
        INSERT INTO subagent_run_number_reservations (
          run_id, allocated_at, owner_id, owner_epoch, native_run_id, activation_id
        ) VALUES ('legacy-run', '2026-09-06T00:00:00.000Z', 'manager', 'epoch', 'legacy', NULL)
      `;
      yield* sql`
        INSERT INTO projection_subagent_runs (
          run_id, run_number, thread_id, parent_run_id, runtime_family, harness,
          provider, provider_instance_id, owner_id, owner_epoch, native_run_id,
          activation_id, model, effort, title, summary, status, terminal_reason,
          control_availability, history_availability, can_steer, can_cancel,
          can_resume, created_at, updated_at, terminal_at, first_event_sequence,
          last_event_sequence
        ) VALUES (
          'legacy-run', 1, 'legacy-thread', NULL, 'pi-stock', 'pi',
          'pi', NULL, 'manager', 'epoch', 'legacy', NULL,
          NULL, NULL, 'Legacy child', NULL, 'active', NULL,
          'owner-routed', 'durable', 1, 1, 0,
          '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z', NULL, 1, 1
        )
      `;
      yield* sql`
        INSERT INTO subagent_transcript_items (
          run_id, transcript_sequence, kind, text, truncated, upstream_truncated, stored_at
        ) VALUES ('legacy-run', 1, 'assistant', 'preserved', 0, 0, '2026-09-06T00:00:00.000Z')
      `;
      yield* runMigrations({ toMigrationInclusive: 58 });
      const legacy = yield* sql<{ readonly text: string }>`
        SELECT text FROM subagent_transcript_items WHERE run_id = 'legacy-run'
      `;
      expect(legacy).toEqual([{ text: "preserved" }]);
      yield* runMigrations({ toMigrationInclusive: 59 });

      const runId = RuntimeTaskId.make("native-durable");
      const childThreadId = ThreadId.make("child-durable");
      const runNumber = yield* repository.reserveRunNumber({
        runId,
        allocatedAt: "2026-09-06T00:00:00.000Z",
        childThreadId,
      });
      const run = NativeChildRun.make({
        runId,
        agentId: runId,
        runNumber,
        parentRunId: null,
        parentThreadId: ThreadId.make("parent-durable"),
        childThreadId,
        providerInstanceId: ProviderInstanceId.make("claude"),
        provider: ProviderDriverKind.make("claudeAgent"),
        model: "claude-sonnet",
        title: "Durable child",
        requestedOptions: [{ id: "effort", value: "high" }],
        runtimeMode: "full-access",
        cwd: "/workspace",
        resumeCursor: { sessionId: "native-session" },
        generation: 1,
        status: "starting",
        output: "",
        outputTruncated: false,
        error: null,
        deliveryState: "pending",
        deliveryAttempt: 0,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:00.000Z",
      });
      yield* repository.insert(run);
      yield* sql`
        INSERT INTO projection_subagent_runs (
          run_id, run_number, thread_id, parent_run_id, runtime_family, harness,
          provider, provider_instance_id, owner_id, owner_epoch, native_run_id,
          activation_id, model, effort, title, summary, status, terminal_reason,
          control_availability, history_availability, can_steer, can_cancel,
          can_resume, created_at, updated_at, terminal_at, first_event_sequence,
          last_event_sequence
        ) VALUES (
          ${runId}, ${runNumber}, ${run.parentThreadId}, NULL, 't3-native', 'claudeAgent',
          'claudeAgent', ${run.providerInstanceId}, NULL, 't3-native', ${childThreadId},
          NULL, ${run.model}, NULL, ${run.title}, NULL, 'active', NULL,
          'owner-routed', 'summary-only', 1, 1, 0, ${run.createdAt}, ${run.updatedAt},
          NULL, 1, 1
        )
      `;
      const interrupted = yield* repository.reconcileRestart("2026-09-06T00:01:00.000Z");
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]).toMatchObject({
        status: "failed",
        resumeCursor: { sessionId: "native-session" },
        requestedOptions: [{ id: "effort", value: "high" }],
        deliveryState: "pending",
      });
      const inventory = yield* sql<{ readonly runtimeFamily: string }>`
        SELECT runtime_family AS "runtimeFamily" FROM projection_subagent_runs WHERE run_id = ${runId}
      `;
      expect(inventory).toEqual([{ runtimeFamily: "t3-native" }]);
    }),
  );

  it.effect("preserves explicit parent-stop delivery suppression across restart", () =>
    Effect.gen(function* () {
      const repository = yield* NativeChildRunRepository;
      yield* runMigrations({ toMigrationInclusive: 59 });
      const runId = RuntimeTaskId.make("native-suppressed-active");
      const parentThreadId = ThreadId.make("parent-suppressed-active");
      const childThreadId = ThreadId.make("child-suppressed-active");
      const createdAt = "2026-09-06T00:00:00.000Z";
      const runNumber = yield* repository.reserveRunNumber({
        runId,
        allocatedAt: createdAt,
        childThreadId,
      });
      yield* repository.insert(
        NativeChildRun.make({
          runId,
          agentId: runId,
          runNumber,
          parentRunId: null,
          parentThreadId,
          childThreadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          provider: ProviderDriverKind.make("codex"),
          model: "gpt-5.6-codex",
          title: "Suppressed child",
          runtimeMode: "full-access",
          cwd: "/workspace",
          resumeCursor: null,
          generation: 1,
          status: "running",
          output: "",
          outputTruncated: false,
          error: null,
          deliveryState: "pending",
          deliveryAttempt: 0,
          createdAt,
          updatedAt: createdAt,
        }),
      );

      yield* repository.markParentDelivered(parentThreadId);
      yield* repository.markDeliveryRetry(runId);
      yield* repository.reconcileRestart("2026-09-06T00:01:00.000Z");

      expect(yield* repository.get(runId)).toMatchObject({
        status: "failed",
        deliveryState: "suppressed",
      });
      expect((yield* repository.get(runId))?.requestedOptions).toBeUndefined();
      expect(yield* repository.listPendingDelivery(parentThreadId)).toHaveLength(1);
    }),
  );
});
