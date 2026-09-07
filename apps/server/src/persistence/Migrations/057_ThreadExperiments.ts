import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_experiments (
      thread_id TEXT PRIMARY KEY,
      goal_generation INTEGER NOT NULL CHECK (goal_generation > 0),
      profile_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_experiments_updated_at
    ON thread_experiments(updated_at)
  `;
});
