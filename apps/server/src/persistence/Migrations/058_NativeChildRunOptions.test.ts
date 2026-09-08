import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("058_NativeChildRunOptions", (it) => {
  it.effect("adds the optional requested options column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(native_child_runs)
      `;
      assert.isFalse(before.some((column) => column.name === "requested_options_json"));

      yield* runMigrations({ toMigrationInclusive: 58 });
      const after = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(native_child_runs)
      `;
      assert.isTrue(after.some((column) => column.name === "requested_options_json"));
    }),
  );
});
