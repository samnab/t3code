import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Phase 1.5 enhanced-manager child transcripts — additive side-store only.
 *
 * Nothing existing is rewritten: the item table and its eviction tombstones
 * are new, and the two run-table columns are nullable additions guarded by
 * presence checks. Rollback keeps every table, row, and eviction range; an
 * older binary ignores the additive schema.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS subagent_transcript_items (
      run_id TEXT NOT NULL,
      transcript_sequence INTEGER NOT NULL CHECK (transcript_sequence > 0),
      kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'toolResult')),
      text TEXT NOT NULL,
      truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
      upstream_truncated INTEGER NOT NULL CHECK (upstream_truncated IN (0, 1)),
      created_at TEXT,
      stored_at TEXT NOT NULL,
      PRIMARY KEY (run_id, transcript_sequence)
    )
  `;

  // Inclusive eviction ranges. The primary key covers the per-run lookup the
  // insert path needs; non-bridging and coalescing rules live in the writer.
  yield* sql`
    CREATE TABLE IF NOT EXISTS subagent_transcript_evictions (
      run_id TEXT NOT NULL,
      from_sequence INTEGER NOT NULL CHECK (from_sequence > 0),
      to_sequence INTEGER NOT NULL CHECK (to_sequence >= from_sequence),
      evicted_at TEXT NOT NULL,
      PRIMARY KEY (run_id, from_sequence)
    )
  `;

  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_subagent_runs)
  `;

  if (!runColumns.some((column) => column.name === "run_birth")) {
    yield* sql`
      ALTER TABLE projection_subagent_runs
      ADD COLUMN run_birth TEXT
    `;
  }

  if (!runColumns.some((column) => column.name === "last_transcript_sequence")) {
    yield* sql`
      ALTER TABLE projection_subagent_runs
      ADD COLUMN last_transcript_sequence INTEGER
    `;
  }
});
