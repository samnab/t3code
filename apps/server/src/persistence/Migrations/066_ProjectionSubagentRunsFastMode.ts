import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_subagent_runs)
  `;

  if (!columns.some((column) => column.name === "fast_mode")) {
    yield* sql`
      ALTER TABLE projection_subagent_runs
      ADD COLUMN fast_mode INTEGER CHECK (fast_mode IS NULL OR fast_mode IN (0, 1))
    `;
  }
});
