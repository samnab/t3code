import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("057_ThreadExperiments", (it) => {
  it.effect("creates the server-only experiment profile table", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* runMigrations({ toMigrationInclusive: 57 });
      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info(thread_experiments)
      `;
      assert.deepEqual(
        columns.map(({ name, pk }) => ({ name, pk })),
        [
          { name: "thread_id", pk: 1 },
          { name: "goal_generation", pk: 0 },
          { name: "profile_json", pk: 0 },
          { name: "updated_at", pk: 0 },
        ],
      );
    }),
  );
});
