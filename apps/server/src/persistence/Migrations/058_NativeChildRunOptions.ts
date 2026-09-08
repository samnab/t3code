import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(native_child_runs)
  `;
  if (!columns.some((column) => column.name === "requested_options_json")) {
    yield* sql`
      ALTER TABLE native_child_runs
      ADD COLUMN requested_options_json TEXT
    `;
  }
});
