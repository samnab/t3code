import { RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  NativeChildRun,
  NativeChildRunRepository,
  type NativeChildRunRepositoryShape,
} from "../Services/NativeChildRuns.ts";

const NativeChildRunDbRow = Schema.Struct({
  ...NativeChildRun.fields,
  resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  outputTruncated: Schema.Number,
});

const UpdateRunning = Schema.Struct({
  runId: RuntimeTaskId,
  resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  updatedAt: Schema.String,
});

const UpdateTerminal = Schema.Struct({
  runId: RuntimeTaskId,
  status: Schema.Literals(["completed", "failed", "cancelled"]),
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  updatedAt: Schema.String,
});

const RunIdInput = Schema.Struct({ runId: RuntimeTaskId });
const ReserveInput = Schema.Struct({
  runId: RuntimeTaskId,
  allocatedAt: Schema.String,
  childThreadId: ThreadId,
});
const RunNumberRow = Schema.Struct({ runNumber: Schema.Number });
const ParentInput = Schema.Struct({ parentThreadId: Schema.NullOr(ThreadId) });
const RestartInput = Schema.Struct({ interruptedAt: Schema.String });

function toRun(row: typeof NativeChildRunDbRow.Type): NativeChildRun {
  return NativeChildRun.make({ ...row, outputTruncated: row.outputTruncated === 1 });
}

function mapRepositoryError(operation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(operation)(cause)
      : toPersistenceSqlError(operation)(cause);
}

export const makeNativeChildRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const reserveRow = SqlSchema.findOne({
    Request: ReserveInput,
    Result: RunNumberRow,
    execute: (input) => sql`
      INSERT INTO subagent_run_number_reservations (
        run_id, allocated_at, owner_id, owner_epoch, native_run_id, activation_id
      ) VALUES (${input.runId}, ${input.allocatedAt}, NULL, 't3-native', ${input.childThreadId}, NULL)
      ON CONFLICT (run_id) DO UPDATE SET run_id = excluded.run_id
      RETURNING run_number AS "runNumber"
    `,
  });

  const insertRow = SqlSchema.void({
    Request: NativeChildRun,
    execute: (run) => sql`
      INSERT INTO native_child_runs (
        run_id, run_number, parent_run_id, parent_thread_id, child_thread_id,
        provider_instance_id, provider, model, title, runtime_mode, cwd,
        resume_cursor_json, generation, status, output, output_truncated,
        error, delivery_state, delivery_attempt, created_at, updated_at
      ) VALUES (
        ${run.runId}, ${run.runNumber}, ${run.parentRunId}, ${run.parentThreadId}, ${run.childThreadId},
        ${run.providerInstanceId}, ${run.provider}, ${run.model}, ${run.title},
        ${run.runtimeMode}, ${run.cwd}, ${run.resumeCursor === null ? null : JSON.stringify(run.resumeCursor)},
        ${run.generation}, ${run.status}, ${run.output}, ${run.outputTruncated ? 1 : 0},
        ${run.error}, ${run.deliveryState}, ${run.deliveryAttempt}, ${run.createdAt}, ${run.updatedAt}
      )
    `,
  });

  const selectColumns = sql`
    run_id AS "runId", run_number AS "runNumber", parent_run_id AS "parentRunId",
    parent_thread_id AS "parentThreadId", child_thread_id AS "childThreadId",
    provider_instance_id AS "providerInstanceId", provider, model, title,
    runtime_mode AS "runtimeMode", cwd, resume_cursor_json AS "resumeCursor",
    generation, status, output, output_truncated AS "outputTruncated", error,
    delivery_state AS "deliveryState", delivery_attempt AS "deliveryAttempt",
    created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const getRow = SqlSchema.findOneOption({
    Request: RunIdInput,
    Result: NativeChildRunDbRow,
    execute: ({ runId }) =>
      sql`SELECT ${selectColumns} FROM native_child_runs WHERE run_id = ${runId}`,
  });
  const listActiveRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NativeChildRunDbRow,
    execute: () => sql`
      SELECT ${selectColumns} FROM native_child_runs
      WHERE status IN ('starting', 'running') ORDER BY created_at ASC
    `,
  });
  const listPendingRows = SqlSchema.findAll({
    Request: ParentInput,
    Result: NativeChildRunDbRow,
    execute: ({ parentThreadId }) => sql`
      SELECT ${selectColumns} FROM native_child_runs
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND delivery_state != 'delivered'
        ${parentThreadId === null ? sql`` : sql`AND parent_thread_id = ${parentThreadId}`}
      ORDER BY updated_at ASC
    `,
  });
  const runningRow = SqlSchema.void({
    Request: UpdateRunning,
    execute: (input) => sql`
      UPDATE native_child_runs SET status = 'running',
        resume_cursor_json = ${input.resumeCursor}, updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId} AND status IN ('starting', 'running')
    `,
  });
  const terminalRow = SqlSchema.void({
    Request: UpdateTerminal,
    execute: (input) => sql`
      UPDATE native_child_runs SET status = ${input.status}, output = ${input.output},
        output_truncated = ${input.outputTruncated ? 1 : 0}, error = ${input.error},
        resume_cursor_json = COALESCE(${input.resumeCursor}, resume_cursor_json),
        delivery_state = 'pending', updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId} AND status IN ('starting', 'running')
    `,
  });
  const deliveredRow = SqlSchema.void({
    Request: RunIdInput,
    execute: ({ runId }) => sql`
      UPDATE native_child_runs SET delivery_state = 'delivered' WHERE run_id = ${runId}
    `,
  });
  const retryRow = SqlSchema.void({
    Request: RunIdInput,
    execute: ({ runId }) => sql`
      UPDATE native_child_runs SET delivery_state = 'pending',
        delivery_attempt = delivery_attempt + 1 WHERE run_id = ${runId}
    `,
  });
  const reconcileRows = SqlSchema.findAll({
    Request: RestartInput,
    Result: NativeChildRunDbRow,
    execute: ({ interruptedAt }) => sql`
      UPDATE native_child_runs SET status = 'failed',
        error = 'T3 Code restarted before the child turn completed.',
        delivery_state = 'pending', updated_at = ${interruptedAt}
      WHERE status IN ('starting', 'running')
      RETURNING ${selectColumns}
    `,
  });

  const mapped = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(mapRepositoryError(operation)));

  return {
    reserveRunNumber: (input) =>
      mapped("NativeChildRunRepository.reserveRunNumber", reserveRow(input)).pipe(
        Effect.map((row) => row.runNumber),
      ),
    insert: (run) => mapped("NativeChildRunRepository.insert", insertRow(run)),
    get: (runId) =>
      mapped("NativeChildRunRepository.get", getRow({ runId })).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: toRun })),
      ),
    listActive: () =>
      mapped("NativeChildRunRepository.listActive", listActiveRows()).pipe(
        Effect.map((rows) => rows.map(toRun)),
      ),
    listPendingDelivery: (parentThreadId) =>
      mapped(
        "NativeChildRunRepository.listPendingDelivery",
        listPendingRows({ parentThreadId: parentThreadId ?? null }),
      ).pipe(Effect.map((rows) => rows.map(toRun))),
    markRunning: (input) => mapped("NativeChildRunRepository.markRunning", runningRow(input)),
    markTerminal: (input) => mapped("NativeChildRunRepository.markTerminal", terminalRow(input)),
    markDelivered: (runId) =>
      mapped("NativeChildRunRepository.markDelivered", deliveredRow({ runId })),
    markDeliveryRetry: (runId) =>
      mapped("NativeChildRunRepository.markDeliveryRetry", retryRow({ runId })),
    reconcileRestart: (interruptedAt) =>
      mapped("NativeChildRunRepository.reconcileRestart", reconcileRows({ interruptedAt })).pipe(
        Effect.map((rows) => rows.map(toRun)),
      ),
  } satisfies NativeChildRunRepositoryShape;
});

export const NativeChildRunRepositoryLive = Layer.effect(
  NativeChildRunRepository,
  makeNativeChildRunRepository,
);

const makeMemoryRepository = Effect.sync(() => {
  const rows = new Map<RuntimeTaskId, NativeChildRun>();
  const numbers = new Map<RuntimeTaskId, number>();
  let nextNumber = 1;
  const update = (runId: RuntimeTaskId, f: (run: NativeChildRun) => NativeChildRun) =>
    Effect.sync(() => {
      const run = rows.get(runId);
      if (run !== undefined) rows.set(runId, f(run));
    });
  return {
    reserveRunNumber: ({ runId }) =>
      Effect.sync(() => {
        const existing = numbers.get(runId);
        if (existing !== undefined) return existing;
        const allocated = nextNumber++;
        numbers.set(runId, allocated);
        return allocated;
      }),
    insert: (run) => Effect.sync(() => void rows.set(run.runId, run)),
    get: (runId) => Effect.sync(() => rows.get(runId) ?? null),
    listActive: () =>
      Effect.sync(() =>
        [...rows.values()].filter((run) => run.status === "starting" || run.status === "running"),
      ),
    listPendingDelivery: (parentThreadId) =>
      Effect.sync(() =>
        [...rows.values()].filter(
          (run) =>
            (parentThreadId === undefined || run.parentThreadId === parentThreadId) &&
            (run.status === "completed" || run.status === "failed" || run.status === "cancelled") &&
            run.deliveryState !== "delivered",
        ),
      ),
    markRunning: (input) =>
      update(input.runId, (run) => ({
        ...run,
        status: "running",
        resumeCursor: input.resumeCursor,
        updatedAt: input.updatedAt,
      })),
    markTerminal: (input) =>
      update(input.runId, (run) => ({
        ...run,
        status: input.status,
        output: input.output,
        outputTruncated: input.outputTruncated,
        error: input.error,
        resumeCursor: input.resumeCursor ?? run.resumeCursor,
        deliveryState: "pending",
        updatedAt: input.updatedAt,
      })),
    markDelivered: (runId) => update(runId, (run) => ({ ...run, deliveryState: "delivered" })),
    markDeliveryRetry: (runId) =>
      update(runId, (run) => ({
        ...run,
        deliveryState: "pending",
        deliveryAttempt: run.deliveryAttempt + 1,
      })),
    reconcileRestart: (interruptedAt) =>
      Effect.sync(() => {
        const interrupted: NativeChildRun[] = [];
        for (const [runId, run] of rows) {
          if (run.status !== "starting" && run.status !== "running") continue;
          const next = NativeChildRun.make({
            ...run,
            status: "failed",
            error: "T3 Code restarted before the child turn completed.",
            deliveryState: "pending",
            updatedAt: interruptedAt,
          });
          rows.set(runId, next);
          interrupted.push(next);
        }
        return interrupted;
      }),
  } satisfies NativeChildRunRepositoryShape;
});

/** Runtime servers have SqlClient; small router/unit harnesses get an isolated store. */
export const NativeChildRunRepositoryAuto = Layer.effect(
  NativeChildRunRepository,
  Effect.serviceOption(SqlClient.SqlClient).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => makeMemoryRepository,
        onSome: (sql) =>
          makeNativeChildRunRepository.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      }),
    ),
  ),
);
