import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { NativeChildRunRepositoryLive } from "../Layers/NativeChildRuns.ts";
import { runMigrations } from "../Migrations.ts";
import { NativeChildMessage, NativeChildRunRepository } from "../Services/NativeChildRuns.ts";

const sqlLayer = NodeSqliteClient.layerMemory();
const testLayer = NativeChildRunRepositoryLive.pipe(Layer.provideMerge(sqlLayer));
const timestamp = "2026-09-08T00:00:00.000Z";

it.layer(testLayer)("059_NativeChildMessaging", (it) => {
  it.effect(
    "backfills stable lineage identities and keeps acknowledged message dedupe records",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* NativeChildRunRepository;
        yield* runMigrations({ toMigrationInclusive: 51 });
        yield* sql`
        INSERT INTO subagent_run_number_reservations
          (run_id, allocated_at, owner_id, owner_epoch, native_run_id, activation_id)
        VALUES
          ('root-run', ${timestamp}, NULL, 't3-native', 'root-child', NULL),
          ('followup-run', ${timestamp}, NULL, 't3-native', 'followup-child', NULL),
          ('orphan-run', ${timestamp}, NULL, 't3-native', 'orphan-child', NULL)
      `;
        yield* sql`
        INSERT INTO native_child_runs (
          run_id, run_number, parent_run_id, parent_thread_id, child_thread_id,
          provider_instance_id, provider, model, title, runtime_mode, cwd,
          resume_cursor_json, generation, status, output, output_truncated,
          error, delivery_state, delivery_attempt, created_at, updated_at
        ) VALUES
          ('root-run', 1, NULL, 'parent', 'root-child', 'claude', 'claudeAgent',
            'sonnet', 'Root', 'full-access', '/workspace', NULL, 1, 'completed', '', 0,
            NULL, 'delivered', 0, ${timestamp}, ${timestamp}),
          ('followup-run', 2, 'root-run', 'parent', 'followup-child', 'claude', 'claudeAgent',
            'sonnet', 'Root', 'full-access', '/workspace', NULL, 2, 'completed', '', 0,
            NULL, 'delivered', 0, ${timestamp}, ${timestamp}),
          ('orphan-run', 3, 'missing-run', 'parent', 'orphan-child', 'codex', 'codex',
            'gpt', 'Orphan', 'full-access', '/workspace', NULL, 2, 'completed', '', 0,
            NULL, 'delivered', 0, ${timestamp}, ${timestamp})
      `;

        yield* runMigrations({ toMigrationInclusive: 59 });
        const identities = yield* sql<{ readonly runId: string; readonly agentId: string }>`
        SELECT run_id AS "runId", agent_id AS "agentId"
        FROM native_child_runs ORDER BY run_id
      `;
        expect(identities).toEqual([
          { runId: "followup-run", agentId: "root-run" },
          { runId: "orphan-run", agentId: "orphan-run" },
          { runId: "root-run", agentId: "root-run" },
        ]);

        const message = NativeChildMessage.make({
          messageId: "message-1",
          parentThreadId: ThreadId.make("parent"),
          senderAgentId: RuntimeTaskId.make("root-run"),
          recipientAgentId: RuntimeTaskId.make("orphan-run"),
          body: "durable body",
          deliveryState: "queued",
          deliveryRunId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          acknowledgedAt: null,
        });
        expect((yield* repository.insertMessage(message)).status).toBe("inserted");
        expect(yield* repository.listPendingMessages(message.recipientAgentId, 50)).toEqual([
          message,
        ]);
        expect(
          yield* repository.acknowledgeMessage({
            parentThreadId: message.parentThreadId,
            recipientAgentId: message.recipientAgentId,
            messageId: message.messageId,
            acknowledgedAt: timestamp,
          }),
        ).toBe(true);
        expect(yield* repository.listPendingMessages(message.recipientAgentId, 50)).toEqual([]);
        expect((yield* repository.insertMessage(message)).status).toBe("duplicate");
        expect(
          (yield* repository.insertMessage(
            NativeChildMessage.make({
              ...message,
              parentThreadId: ThreadId.make("another-parent"),
              senderAgentId: RuntimeTaskId.make("another-sender"),
              recipientAgentId: RuntimeTaskId.make("another-recipient"),
            }),
          )).status,
        ).toBe("inserted");

        yield* sql`
        UPDATE native_child_runs SET status = 'running', created_at = '2026-09-09T00:00:00.000Z'
        WHERE run_id = 'orphan-run'
      `;
        expect(yield* repository.listLatestByParent(ThreadId.make("parent"), 1)).toMatchObject([
          { agentId: RuntimeTaskId.make("orphan-run"), status: "running" },
        ]);
      }),
  );
});
