import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import { reconcileForkMigrationLedger } from "./reconcileForkMigrationLedger.ts";

const forkHistory = [
  [46, "ProjectionSubagentRuns"],
  [47, "ProjectionThreadGoal"],
  [48, "ProjectionSubagentTranscripts"],
  [49, "ProjectionThreadsVoiceNotifications"],
  [50, "ProjectionThreadGoalLoop"],
  [51, "NativeChildRuns"],
  [52, "ProjectionThreadMessagesOrigin"],
  [53, "RepairAutomaticSettlementTimestamps"],
  [54, "ProjectionProjectIcon"],
  [55, "ProjectionThreadBranchPullRequest"],
  [56, "ProjectionThreadsActiveOrderKey"],
  [57, "ThreadExperiments"],
  [58, "NativeChildRunOptions"],
  [59, "NativeChildMessaging"],
  [60, "NativeChildDeliveryBatches"],
  [61, "ProjectionThreadPullRequests"],
  [62, "ProjectionThreadMessageContext"],
  [63, "ProjectionThreadTitleState"],
  [64, "ProjectionProjectsSchedules"],
  [65, "PullRequestFilesViewed"],
  [66, "ProjectionSubagentRunsFastMode"],
  [67, "ProjectionThreadsAutoSettleDisabledAt"],
] as const;

const forkTableNames = [
  "native_child_delivery_batch_runs",
  "native_child_delivery_batches",
  "native_child_messages",
  "native_child_runs",
  "projection_subagent_runs",
  "subagent_run_number_reservations",
  "subagent_transcript_evictions",
  "subagent_transcript_items",
  "thread_experiments",
] as const;

const readHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly migration_id: number;
    readonly name: string;
    readonly created_at: string;
  }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
});

// The fork tables keep only the columns needed to reproduce their foreign-key graph.
const seedForkDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 46`;

  yield* sql`ALTER TABLE projection_threads ADD COLUMN goal TEXT`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN voice_notifications INTEGER NOT NULL DEFAULT 1`;
  yield* sql`ALTER TABLE projection_threads ADD COLUMN goal_loop_json TEXT`;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN origin TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN schedules_json TEXT NOT NULL DEFAULT '[]'`;

  yield* sql`
    CREATE TABLE subagent_run_number_reservations (
      run_number INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE
    )
  `;
  yield* sql`
    CREATE TABLE projection_subagent_runs (
      run_id TEXT PRIMARY KEY,
      run_number INTEGER NOT NULL UNIQUE,
      run_birth TEXT,
      last_transcript_sequence INTEGER,
      fast_mode INTEGER CHECK (fast_mode IS NULL OR fast_mode IN (0, 1)),
      FOREIGN KEY (run_number) REFERENCES subagent_run_number_reservations(run_number)
    )
  `;
  yield* sql`
    CREATE TABLE subagent_transcript_items (
      run_id TEXT NOT NULL,
      transcript_sequence INTEGER NOT NULL,
      PRIMARY KEY (run_id, transcript_sequence),
      FOREIGN KEY (run_id) REFERENCES projection_subagent_runs(run_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE TABLE subagent_transcript_evictions (
      run_id TEXT NOT NULL,
      from_sequence INTEGER NOT NULL,
      PRIMARY KEY (run_id, from_sequence),
      FOREIGN KEY (run_id) REFERENCES projection_subagent_runs(run_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE TABLE native_child_runs (
      run_id TEXT PRIMARY KEY,
      run_number INTEGER NOT NULL UNIQUE,
      requested_options_json TEXT,
      agent_id TEXT,
      FOREIGN KEY (run_number) REFERENCES subagent_run_number_reservations(run_number)
    )
  `;
  yield* sql`
    CREATE TABLE native_child_messages (
      parent_thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (parent_thread_id, message_id)
    )
  `;
  yield* sql`
    CREATE TABLE native_child_delivery_batches (
      batch_id TEXT PRIMARY KEY
    )
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
    CREATE TABLE thread_experiments (
      thread_id TEXT PRIMARY KEY,
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    INSERT INTO subagent_run_number_reservations (run_number, run_id) VALUES (1, 'fork-run')
  `;
  yield* sql`
    INSERT INTO projection_subagent_runs (run_id, run_number) VALUES ('fork-run', 1)
  `;
  yield* sql`
    INSERT INTO subagent_transcript_items (run_id, transcript_sequence) VALUES ('fork-run', 1)
  `;
  yield* sql`
    INSERT INTO subagent_transcript_evictions (run_id, from_sequence) VALUES ('fork-run', 1)
  `;
  yield* sql`
    INSERT INTO native_child_runs (run_id, run_number) VALUES ('native-run', 1)
  `;
  yield* sql`INSERT INTO native_child_delivery_batches (batch_id) VALUES ('batch')`;
  yield* sql`
    INSERT INTO native_child_delivery_batch_runs (batch_id, run_id) VALUES ('batch', 'native-run')
  `;

  for (const [migrationId, name] of forkHistory) {
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${migrationId}, ${name})
    `;
  }
});

describe("fork migration ledger reconciliation", () => {
  it.effect("leaves a database without a migration ledger unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a pristine upstream ledger unchanged", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      const before = yield* readHistory;
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a site-local upstream migration name unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'ThreadSummaryTimeline')
      `;
      const before = yield* readHistory;

      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects a fork-only migration name at an unexpected id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (41, 'ProjectionThreadGoal')
      `;
      const before = yield* readHistory;

      const error = yield* Effect.flip(reconcileForkMigrationLedger());
      assert.isTrue(error instanceof Migrator.MigrationError);
      if (error instanceof Migrator.MigrationError) {
        assert.strictEqual(error.kind, "BadState");
      }
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "rewrites the exact fork ledger, prunes fork tables, and runs migrations 55 and 56",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedForkDatabase;

        assert.deepStrictEqual(yield* runMigrations(), [
          [55, "OrchestrationV2"],
          [56, "RemoveRedundantProjectionIndexes"],
        ]);
        const history = yield* readHistory;
        assert.deepStrictEqual(
          history.map(({ migration_id, name }) => [migration_id, name] as const),
          migrationManifest,
        );
        assert.deepStrictEqual(
          yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ${sql.in(forkTableNames)}
        `,
          [],
        );
        assert.deepStrictEqual(
          yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'orchestration_v2_events'
        `,
          [{ name: "orchestration_v2_events" }],
        );

        const threadColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_threads)`;
        const messageColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_thread_messages)`;
        const projectColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(projection_projects)`;
        assert.isTrue(threadColumns.some(({ name }) => name === "goal"));
        assert.isTrue(threadColumns.some(({ name }) => name === "goal_loop_json"));
        assert.isTrue(threadColumns.some(({ name }) => name === "voice_notifications"));
        assert.isTrue(messageColumns.some(({ name }) => name === "origin"));
        assert.isTrue(projectColumns.some(({ name }) => name === "schedules_json"));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects a partial fork signature without changing the ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 66`;
      const before = yield* readHistory;

      const error = yield* Effect.flip(reconcileForkMigrationLedger());
      assert.isTrue(error instanceof Migrator.MigrationError);
      if (error instanceof Migrator.MigrationError) {
        assert.strictEqual(error.kind, "BadState");
      }
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("allows a safe retry after reconciliation and then runs migration 55", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      const before = yield* readHistory;
      assert.deepStrictEqual(
        before.map(({ migration_id, name }) => [migration_id, name] as const),
        migrationManifest.slice(0, 54),
      );
      assert.strictEqual(before.at(-1)?.migration_id, 54);
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* readHistory, before);

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), [
        [55, "OrchestrationV2"],
      ]);
      assert.deepStrictEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'orchestration_v2_events'
        `,
        [{ name: "orchestration_v2_events" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves a fully migrated upstream database unchanged", () =>
    Effect.gen(function* () {
      yield* seedForkDatabase;
      yield* runMigrations();
      const before = yield* readHistory;
      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("leaves future upstream migrations unchanged and allows migration startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      for (let migrationId = 57; migrationId <= 70; migrationId++) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${migrationId}, ${`FutureUpstreamMigration${migrationId}`})
        `;
      }
      const before = yield* readHistory;

      assert.deepStrictEqual(yield* reconcileForkMigrationLedger(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* readHistory, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rejects fork rows when orchestration v2 tables already exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;
      yield* sql`CREATE TABLE orchestration_v2_events (sequence INTEGER PRIMARY KEY)`;
      const before = yield* readHistory;

      const error = yield* Effect.flip(reconcileForkMigrationLedger());
      assert.isTrue(error instanceof Migrator.MigrationError);
      if (error instanceof Migrator.MigrationError) {
        assert.strictEqual(error.kind, "BadState");
      }
      assert.deepStrictEqual(yield* readHistory, before);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_events'`,
        [{ name: "orchestration_v2_events" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back ledger deletions when reconciliation fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedForkDatabase;
      yield* sql`
        CREATE TRIGGER fail_fork_reconciliation BEFORE UPDATE ON effect_sql_migrations
        WHEN OLD.migration_id = 53
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
      const before = yield* readHistory;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(reconcileForkMigrationLedger())));
      assert.deepStrictEqual(yield* readHistory, before);
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ${sql.in(forkTableNames)}
      `;
      assert.strictEqual(tables.length, forkTableNames.length);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
