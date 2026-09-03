import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // AUTOINCREMENT keeps a committed reservation consumed even if its row is
  // later deleted. The inventory row is written separately, so failures leave
  // an intentional gap rather than making a number reusable.
  yield* sql`
    CREATE TABLE IF NOT EXISTS subagent_run_number_reservations (
      run_number INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      allocated_at TEXT NOT NULL,
      owner_id TEXT,
      owner_epoch TEXT NOT NULL,
      native_run_id TEXT,
      activation_id TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_subagent_runs (
      run_id TEXT PRIMARY KEY,
      run_number INTEGER NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      parent_run_id TEXT,
      runtime_family TEXT NOT NULL CHECK (runtime_family IN ('pi-stock', 'pi-manager')),
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
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'active', 'cancelling', 'done', 'error', 'cancelled', 'interrupted')
      ),
      terminal_reason TEXT CHECK (
        terminal_reason IS NULL OR terminal_reason IN (
          'native-completed',
          'native-error',
          'native-cancelled',
          'owner-lost',
          'owner-replaced',
          'server-restart'
        )
      ),
      control_availability TEXT NOT NULL CHECK (
        control_availability IN ('owner-routed', 'read-only', 'unsupported')
      ),
      history_availability TEXT NOT NULL CHECK (
        history_availability IN ('durable', 'summary-only', 'unavailable')
      ),
      can_steer INTEGER NOT NULL CHECK (can_steer IN (0, 1)),
      can_cancel INTEGER NOT NULL CHECK (can_cancel IN (0, 1)),
      can_resume INTEGER NOT NULL CHECK (can_resume IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      first_event_sequence INTEGER NOT NULL,
      last_event_sequence INTEGER NOT NULL,
      FOREIGN KEY (run_number) REFERENCES subagent_run_number_reservations(run_number),
      CHECK (
        (status IN ('done', 'error', 'cancelled', 'interrupted') AND terminal_at IS NOT NULL)
        OR
        (status IN ('queued', 'active', 'cancelling') AND terminal_at IS NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_subagent_runs_thread_number
    ON projection_subagent_runs(thread_id, run_number DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_subagent_runs_owner
    ON projection_subagent_runs(owner_id, owner_epoch, native_run_id, activation_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_subagent_runs_nonterminal
    ON projection_subagent_runs(status)
    WHERE status IN ('queued', 'active', 'cancelling')
  `;
});
