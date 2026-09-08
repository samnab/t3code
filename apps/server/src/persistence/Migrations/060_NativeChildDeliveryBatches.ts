import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE native_child_delivery_batches (
      batch_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      text TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'delivered', 'rejected', 'suppressed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_native_child_delivery_batches_open_parent
    ON native_child_delivery_batches(parent_thread_id)
    WHERE state = 'prepared'
  `;
  yield* sql`
    CREATE TABLE native_child_delivery_batch_runs (
      batch_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      PRIMARY KEY (batch_id, run_id),
      FOREIGN KEY (batch_id) REFERENCES native_child_delivery_batches(batch_id),
      FOREIGN KEY (run_id) REFERENCES native_child_runs(run_id)
    )
  `;
  yield* sql`
    CREATE INDEX idx_native_child_delivery_batch_runs_run
    ON native_child_delivery_batch_runs(run_id)
  `;
});
