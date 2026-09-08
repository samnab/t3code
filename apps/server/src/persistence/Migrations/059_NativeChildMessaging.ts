import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE native_child_runs ADD COLUMN agent_id TEXT`;
  yield* sql`
    WITH RECURSIVE child_lineage(run_id, agent_id) AS (
      SELECT run_id, run_id FROM native_child_runs WHERE parent_run_id IS NULL
      UNION ALL
      SELECT child.run_id, child_lineage.agent_id
      FROM native_child_runs AS child
      JOIN child_lineage ON child.parent_run_id = child_lineage.run_id
    )
    UPDATE native_child_runs
    SET agent_id = COALESCE(
      (SELECT child_lineage.agent_id FROM child_lineage WHERE child_lineage.run_id = native_child_runs.run_id),
      run_id
    )
  `;
  yield* sql`
    CREATE INDEX idx_native_child_runs_parent_agent_generation
    ON native_child_runs(parent_thread_id, agent_id, generation DESC)
  `;

  yield* sql`
    CREATE TABLE native_child_messages (
      message_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      sender_agent_id TEXT NOT NULL,
      recipient_agent_id TEXT NOT NULL,
      body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('queued', 'notified')),
      delivery_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT,
      PRIMARY KEY (parent_thread_id, message_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_native_child_messages_inbox
    ON native_child_messages(recipient_agent_id, acknowledged_at, created_at)
  `;
});
