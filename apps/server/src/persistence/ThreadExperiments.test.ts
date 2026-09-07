import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import type { ExperimentProfile } from "../experiments/Model.ts";
import { runMigrations } from "./Migrations.ts";
import { makeThreadExperimentStore } from "./ThreadExperiments.ts";

const profile = (updatedAt: string): ExperimentProfile => ({
  version: 1,
  runId: "11111111-1111-4111-8111-111111111111",
  threadId: "thread-1",
  goalGeneration: 1,
  objective: "Improve the score",
  phase: "ready",
  armed: true,
  cwd: "/repo",
  branch: "experiment/test",
  head: "a".repeat(40),
  providerInstanceId: "claude",
  providerSessionId: "session-1",
  providerDriver: "claudeAgent",
  providerSessionActive: true,
  config: {
    version: 1,
    branch: "experiment/test",
    files: ["train.py"],
    evaluator: {
      argv: ["python3", "train.py"],
      metric: "score",
      direction: "higher",
      minimumImprovement: 0,
    },
    checks: [["python3", "-m", "py_compile", "train.py"]],
    limits: {
      maxExperiments: 10,
      maxApplyBytes: 100_000,
      maxOutputBytes: 100_000,
      evaluatorTimeoutSeconds: 60,
      checkTimeoutSeconds: 30,
      maxTotalSeconds: 600,
    },
  },
  configDigest: "b".repeat(64),
  baselineMetric: 1,
  bestMetric: 1,
  lastMetric: 1,
  experimentsRun: 0,
  experimentsKept: 0,
  experimentsRestored: 0,
  commandSeconds: 1,
  createdAt: "2026-09-07T00:00:00.000Z",
  deadlineAt: "2026-09-07T00:10:00.000Z",
  updatedAt,
  pending: null,
  lastError: null,
});

it.layer(NodeSqliteClient.layerMemory())("ThreadExperimentStore", (it) => {
  it.effect("round-trips and replaces a profile by thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('project-1', 'Project', '/repo', '[]', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Thread', '{"instanceId":"claude","model":"sonnet"}',
          'full-access', '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z'
        )
      `;
      const store = yield* makeThreadExperimentStore;
      yield* store.save(profile("2026-09-07T00:00:01.000Z"));
      yield* store.save({
        ...profile("2026-09-07T00:00:02.000Z"),
        experimentsRun: 1,
        experimentsRestored: 1,
      });
      const read = Option.getOrThrow(yield* store.get("thread-1"));
      assert.strictEqual(read.experimentsRun, 1);
      assert.strictEqual(read.experimentsRestored, 1);
      assert.strictEqual((yield* store.list()).length, 1);
    }),
  );
});
