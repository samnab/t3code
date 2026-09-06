import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite cannot widen a CHECK constraint in place. Rebuild the two child
  // transcript tables with the run table so their foreign keys and rows survive
  // replacing the parent table.
  yield* sql`PRAGMA legacy_alter_table = ON`;
  yield* sql`
    ALTER TABLE subagent_transcript_items RENAME TO subagent_transcript_items_v50
  `;
  yield* sql`
    ALTER TABLE subagent_transcript_evictions RENAME TO subagent_transcript_evictions_v50
  `;
  yield* sql`ALTER TABLE projection_subagent_runs RENAME TO projection_subagent_runs_v50`;
  yield* sql`
    CREATE TABLE projection_subagent_runs (
      run_id TEXT PRIMARY KEY,
      run_number INTEGER NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      parent_run_id TEXT,
      runtime_family TEXT NOT NULL CHECK (runtime_family IN ('pi-stock', 'pi-manager', 't3-native')),
      harness TEXT,
      provider TEXT NOT NULL,
      provider_instance_id TEXT,
      owner_id TEXT,
      owner_epoch TEXT NOT NULL,
      native_run_id TEXT,
      activation_id TEXT,
      model TEXT,
      effort TEXT,
      title TEXT,
      summary TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'cancelling', 'done', 'error', 'cancelled', 'interrupted')),
      terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('native-completed', 'native-error', 'native-cancelled', 'owner-lost', 'owner-replaced', 'server-restart')),
      control_availability TEXT NOT NULL CHECK (control_availability IN ('owner-routed', 'read-only', 'unsupported')),
      history_availability TEXT NOT NULL CHECK (history_availability IN ('durable', 'summary-only', 'unavailable')),
      can_steer INTEGER NOT NULL CHECK (can_steer IN (0, 1)),
      can_cancel INTEGER NOT NULL CHECK (can_cancel IN (0, 1)),
      can_resume INTEGER NOT NULL CHECK (can_resume IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      first_event_sequence INTEGER NOT NULL,
      last_event_sequence INTEGER NOT NULL,
      run_birth TEXT,
      last_transcript_sequence INTEGER,
      FOREIGN KEY (run_number) REFERENCES subagent_run_number_reservations(run_number),
      CHECK ((status IN ('done', 'error', 'cancelled', 'interrupted') AND terminal_at IS NOT NULL) OR (status IN ('queued', 'active', 'cancelling') AND terminal_at IS NULL))
    )
  `;
  yield* sql`
    INSERT INTO projection_subagent_runs SELECT * FROM projection_subagent_runs_v50
  `;
  yield* sql`
    CREATE TABLE subagent_transcript_items (
      run_id TEXT NOT NULL,
      transcript_sequence INTEGER NOT NULL CHECK (transcript_sequence > 0),
      kind TEXT NOT NULL CHECK (kind IN ('user', 'assistant', 'toolResult')),
      text TEXT NOT NULL,
      truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
      upstream_truncated INTEGER NOT NULL CHECK (upstream_truncated IN (0, 1)),
      created_at TEXT,
      stored_at TEXT NOT NULL,
      PRIMARY KEY (run_id, transcript_sequence),
      FOREIGN KEY (run_id) REFERENCES projection_subagent_runs(run_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO subagent_transcript_items SELECT * FROM subagent_transcript_items_v50
  `;
  yield* sql`
    CREATE TABLE subagent_transcript_evictions (
      run_id TEXT NOT NULL,
      from_sequence INTEGER NOT NULL CHECK (from_sequence > 0),
      to_sequence INTEGER NOT NULL CHECK (to_sequence >= from_sequence),
      evicted_at TEXT NOT NULL,
      PRIMARY KEY (run_id, from_sequence),
      FOREIGN KEY (run_id) REFERENCES projection_subagent_runs(run_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    INSERT INTO subagent_transcript_evictions SELECT * FROM subagent_transcript_evictions_v50
  `;
  yield* sql`DROP TABLE subagent_transcript_items_v50`;
  yield* sql`DROP TABLE subagent_transcript_evictions_v50`;
  yield* sql`DROP TABLE projection_subagent_runs_v50`;
  yield* sql`
    CREATE INDEX idx_projection_subagent_runs_thread_number
    ON projection_subagent_runs(thread_id, run_number DESC)
  `;
  yield* sql`
    CREATE INDEX idx_projection_subagent_runs_owner
    ON projection_subagent_runs(owner_id, owner_epoch, native_run_id, activation_id)
  `;
  yield* sql`
    CREATE INDEX idx_projection_subagent_runs_nonterminal
    ON projection_subagent_runs(status)
    WHERE status IN ('queued', 'active', 'cancelling')
  `;
  yield* sql`PRAGMA legacy_alter_table = OFF`;

  yield* sql`
    CREATE TABLE native_child_runs (
      run_id TEXT PRIMARY KEY,
      run_number INTEGER NOT NULL UNIQUE,
      parent_run_id TEXT,
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL UNIQUE,
      provider_instance_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      title TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      cwd TEXT NOT NULL,
      resume_cursor_json TEXT,
      generation INTEGER NOT NULL CHECK (generation > 0),
      status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'failed', 'cancelled')),
      output TEXT NOT NULL,
      output_truncated INTEGER NOT NULL CHECK (output_truncated IN (0, 1)),
      error TEXT,
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivering', 'delivered')),
      delivery_attempt INTEGER NOT NULL CHECK (delivery_attempt >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_number) REFERENCES subagent_run_number_reservations(run_number)
    )
  `;
  yield* sql`
    CREATE INDEX idx_native_child_runs_parent_status
    ON native_child_runs(parent_thread_id, status)
  `;
  yield* sql`
    CREATE INDEX idx_native_child_runs_delivery
    ON native_child_runs(delivery_state, parent_thread_id)
  `;
});
