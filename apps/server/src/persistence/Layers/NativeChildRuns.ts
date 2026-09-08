import { RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  NativeChildMessage,
  NativeChildRun,
  NATIVE_CHILD_RESTART_ERROR,
  NativeChildRunRepository,
  type NativeChildRunRepositoryShape,
} from "../Services/NativeChildRuns.ts";

const NativeChildRunDbRow = Schema.Struct({
  ...NativeChildRun.fields,
  resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  outputTruncated: Schema.Number,
});

const NativeChildMessageDbRow = NativeChildMessage;

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
const ChildThreadInput = Schema.Struct({ childThreadId: ThreadId });
const AgentIdInput = Schema.Struct({ agentId: RuntimeTaskId });
const ReserveInput = Schema.Struct({
  runId: RuntimeTaskId,
  allocatedAt: Schema.String,
  childThreadId: ThreadId,
});
const RunNumberRow = Schema.Struct({ runNumber: Schema.Number });
const ParentInput = Schema.Struct({ parentThreadId: Schema.NullOr(ThreadId) });
const RestartInput = Schema.Struct({ interruptedAt: Schema.String });
const PendingMessageInput = Schema.Struct({
  recipientAgentId: RuntimeTaskId,
  limit: Schema.Int,
});
const AcknowledgeMessageInput = Schema.Struct({
  parentThreadId: ThreadId,
  recipientAgentId: RuntimeTaskId,
  messageId: Schema.String,
  acknowledgedAt: Schema.String,
});
const MarkMessageNotifiedInput = Schema.Struct({
  parentThreadId: ThreadId,
  messageId: Schema.String,
  deliveryRunId: RuntimeTaskId,
  updatedAt: Schema.String,
});
const MessageIdInput = Schema.Struct({ parentThreadId: ThreadId, messageId: Schema.String });
const MessageIdRow = Schema.Struct({ messageId: Schema.String });

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
        run_id, agent_id, run_number, parent_run_id, parent_thread_id, child_thread_id,
        provider_instance_id, provider, model, title, runtime_mode, cwd,
        resume_cursor_json, generation, status, output, output_truncated,
        error, delivery_state, delivery_attempt, created_at, updated_at
      ) VALUES (
        ${run.runId}, ${run.agentId}, ${run.runNumber}, ${run.parentRunId}, ${run.parentThreadId}, ${run.childThreadId},
        ${run.providerInstanceId}, ${run.provider}, ${run.model}, ${run.title},
        ${run.runtimeMode}, ${run.cwd}, ${run.resumeCursor === null ? null : JSON.stringify(run.resumeCursor)},
        ${run.generation}, ${run.status}, ${run.output}, ${run.outputTruncated ? 1 : 0},
        ${run.error}, ${run.deliveryState}, ${run.deliveryAttempt}, ${run.createdAt}, ${run.updatedAt}
      )
    `,
  });

  const selectColumns = sql`
    run_id AS "runId", agent_id AS "agentId", run_number AS "runNumber", parent_run_id AS "parentRunId",
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
  const getByChildThreadRow = SqlSchema.findOneOption({
    Request: ChildThreadInput,
    Result: NativeChildRunDbRow,
    execute: ({ childThreadId }) =>
      sql`SELECT ${selectColumns} FROM native_child_runs WHERE child_thread_id = ${childThreadId}`,
  });
  const getLatestByAgentRow = SqlSchema.findOneOption({
    Request: AgentIdInput,
    Result: NativeChildRunDbRow,
    execute: ({ agentId }) => sql`
      SELECT ${selectColumns} FROM native_child_runs
      WHERE agent_id = ${agentId}
      ORDER BY generation DESC LIMIT 1
    `,
  });
  const listLatestByParentRows = SqlSchema.findAll({
    Request: Schema.Struct({ parentThreadId: ThreadId, limit: Schema.Int }),
    Result: NativeChildRunDbRow,
    execute: ({ parentThreadId, limit }) => sql`
      SELECT ${selectColumns} FROM native_child_runs AS run
      WHERE run.parent_thread_id = ${parentThreadId}
        AND NOT EXISTS (
          SELECT 1 FROM native_child_runs AS newer
          WHERE newer.agent_id = run.agent_id AND newer.generation > run.generation
        )
      ORDER BY CASE WHEN run.status IN ('starting', 'running') THEN 0 ELSE 1 END,
        run.created_at DESC
      LIMIT ${limit}
    `,
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
        delivery_state = CASE
          WHEN delivery_state IN ('suppressed', 'delivered') THEN delivery_state
          ELSE 'pending'
        END,
        updated_at = ${input.updatedAt}
      WHERE run_id = ${input.runId} AND status IN ('starting', 'running')
    `,
  });
  const deliveredRow = SqlSchema.void({
    Request: RunIdInput,
    execute: ({ runId }) => sql`
      UPDATE native_child_runs SET delivery_state = 'delivered' WHERE run_id = ${runId}
    `,
  });
  const parentDeliveredRows = SqlSchema.void({
    Request: Schema.Struct({ parentThreadId: ThreadId }),
    execute: ({ parentThreadId }) => sql`
      UPDATE native_child_runs SET delivery_state = CASE
        WHEN delivery_state = 'delivered' THEN 'delivered'
        ELSE 'suppressed'
      END
      WHERE parent_thread_id = ${parentThreadId}
    `,
  });
  const retryRow = SqlSchema.void({
    Request: RunIdInput,
    execute: ({ runId }) => sql`
      UPDATE native_child_runs SET delivery_state = CASE
          WHEN delivery_state IN ('suppressed', 'delivered') THEN delivery_state
          ELSE 'pending'
        END,
        delivery_attempt = delivery_attempt + 1 WHERE run_id = ${runId}
    `,
  });
  const reconcileRows = SqlSchema.findAll({
    Request: RestartInput,
    Result: NativeChildRunDbRow,
    execute: ({ interruptedAt }) => sql`
      UPDATE native_child_runs SET status = 'failed',
        error = ${NATIVE_CHILD_RESTART_ERROR},
        delivery_state = CASE
          WHEN delivery_state IN ('suppressed', 'delivered') THEN delivery_state
          ELSE 'pending'
        END,
        updated_at = ${interruptedAt}
      WHERE status IN ('starting', 'running')
      RETURNING ${selectColumns}
    `,
  });

  const messageColumns = sql`
    message_id AS "messageId", parent_thread_id AS "parentThreadId",
    sender_agent_id AS "senderAgentId", recipient_agent_id AS "recipientAgentId",
    body, delivery_state AS "deliveryState", delivery_run_id AS "deliveryRunId",
    created_at AS "createdAt", updated_at AS "updatedAt",
    acknowledged_at AS "acknowledgedAt"
  `;
  const getMessageRow = SqlSchema.findOneOption({
    Request: MessageIdInput,
    Result: NativeChildMessageDbRow,
    execute: ({ parentThreadId, messageId }) => sql`
      SELECT ${messageColumns} FROM native_child_messages
      WHERE parent_thread_id = ${parentThreadId} AND message_id = ${messageId}
    `,
  });
  const insertMessageRow = SqlSchema.findOneOption({
    Request: NativeChildMessage,
    Result: NativeChildMessageDbRow,
    execute: (message) => sql`
      INSERT INTO native_child_messages (
        message_id, parent_thread_id, sender_agent_id, recipient_agent_id, body,
        delivery_state, delivery_run_id, created_at, updated_at, acknowledged_at
      )
      SELECT ${message.messageId}, ${message.parentThreadId}, ${message.senderAgentId},
        ${message.recipientAgentId}, ${message.body}, ${message.deliveryState},
        ${message.deliveryRunId}, ${message.createdAt}, ${message.updatedAt},
        ${message.acknowledgedAt}
      WHERE (
        SELECT COUNT(*) FROM native_child_messages
        WHERE recipient_agent_id = ${message.recipientAgentId} AND acknowledged_at IS NULL
      ) < 100
      ON CONFLICT (parent_thread_id, message_id) DO NOTHING
      RETURNING ${messageColumns}
    `,
  });
  const listPendingMessageRows = SqlSchema.findAll({
    Request: PendingMessageInput,
    Result: NativeChildMessageDbRow,
    execute: ({ recipientAgentId, limit }) => sql`
      SELECT ${messageColumns} FROM native_child_messages
      WHERE recipient_agent_id = ${recipientAgentId} AND acknowledged_at IS NULL
      ORDER BY created_at ASC LIMIT ${limit}
    `,
  });
  const acknowledgeMessageRow = SqlSchema.findOneOption({
    Request: AcknowledgeMessageInput,
    Result: MessageIdRow,
    execute: (input) => sql`
      UPDATE native_child_messages
      SET acknowledged_at = ${input.acknowledgedAt}, updated_at = ${input.acknowledgedAt}
      WHERE message_id = ${input.messageId}
        AND parent_thread_id = ${input.parentThreadId}
        AND recipient_agent_id = ${input.recipientAgentId}
        AND acknowledged_at IS NULL
      RETURNING message_id AS "messageId"
    `,
  });
  const markMessageNotifiedRow = SqlSchema.void({
    Request: MarkMessageNotifiedInput,
    execute: (input) => sql`
      UPDATE native_child_messages
      SET delivery_state = 'notified', delivery_run_id = ${input.deliveryRunId},
        updated_at = ${input.updatedAt}
      WHERE parent_thread_id = ${input.parentThreadId}
        AND message_id = ${input.messageId} AND delivery_state = 'queued'
    `,
  });

  const mapped = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(mapRepositoryError(operation)));

  const insertMessage: NativeChildRunRepositoryShape["insertMessage"] = Effect.fn(
    "NativeChildRunRepository.insertMessage",
  )(function* (message) {
    const inserted = yield* mapped(
      "NativeChildRunRepository.insertMessage",
      insertMessageRow(message),
    );
    if (Option.isSome(inserted)) return { status: "inserted", message: inserted.value };
    const existing = yield* mapped(
      "NativeChildRunRepository.getMessageAfterInsert",
      getMessageRow({ parentThreadId: message.parentThreadId, messageId: message.messageId }),
    );
    if (Option.isNone(existing)) return { status: "inbox-full" };
    return existing.value.parentThreadId === message.parentThreadId &&
      existing.value.senderAgentId === message.senderAgentId &&
      existing.value.recipientAgentId === message.recipientAgentId &&
      existing.value.body === message.body
      ? { status: "duplicate", message: existing.value }
      : { status: "conflict" };
  });

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
    getByChildThread: (childThreadId) =>
      mapped(
        "NativeChildRunRepository.getByChildThread",
        getByChildThreadRow({ childThreadId }),
      ).pipe(Effect.map(Option.match({ onNone: () => null, onSome: toRun }))),
    getLatestByAgent: (agentId) =>
      mapped("NativeChildRunRepository.getLatestByAgent", getLatestByAgentRow({ agentId })).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: toRun })),
      ),
    listLatestByParent: (parentThreadId, limit) =>
      mapped(
        "NativeChildRunRepository.listLatestByParent",
        listLatestByParentRows({ parentThreadId, limit }),
      ).pipe(Effect.map((rows) => rows.map(toRun))),
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
    markParentDelivered: (parentThreadId) =>
      mapped(
        "NativeChildRunRepository.markParentDelivered",
        parentDeliveredRows({ parentThreadId }),
      ),
    markDeliveryRetry: (runId) =>
      mapped("NativeChildRunRepository.markDeliveryRetry", retryRow({ runId })),
    reconcileRestart: (interruptedAt) =>
      mapped("NativeChildRunRepository.reconcileRestart", reconcileRows({ interruptedAt })).pipe(
        Effect.map((rows) => rows.map(toRun)),
      ),
    insertMessage,
    listPendingMessages: (recipientAgentId, limit) =>
      mapped(
        "NativeChildRunRepository.listPendingMessages",
        listPendingMessageRows({ recipientAgentId, limit }),
      ),
    acknowledgeMessage: (input) =>
      mapped("NativeChildRunRepository.acknowledgeMessage", acknowledgeMessageRow(input)).pipe(
        Effect.map(Option.isSome),
      ),
    markMessageNotified: (input) =>
      mapped("NativeChildRunRepository.markMessageNotified", markMessageNotifiedRow(input)),
  } satisfies NativeChildRunRepositoryShape;
});

export const NativeChildRunRepositoryLive = Layer.effect(
  NativeChildRunRepository,
  makeNativeChildRunRepository,
);

const makeMemoryRepository = Effect.sync(() => {
  const rows = new Map<RuntimeTaskId, NativeChildRun>();
  const messages = new Map<string, NativeChildMessage>();
  const messageKey = (parentThreadId: ThreadId, messageId: string) =>
    `${parentThreadId}\u0000${messageId}`;
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
    getByChildThread: (childThreadId) =>
      Effect.sync(
        () => [...rows.values()].find((run) => run.childThreadId === childThreadId) ?? null,
      ),
    getLatestByAgent: (agentId) =>
      Effect.sync(
        () =>
          [...rows.values()]
            .filter((run) => run.agentId === agentId)
            .sort((left, right) => right.generation - left.generation)[0] ?? null,
      ),
    listLatestByParent: (parentThreadId, limit) =>
      Effect.sync(() => {
        const latest = new Map<RuntimeTaskId, NativeChildRun>();
        for (const run of rows.values()) {
          if (run.parentThreadId !== parentThreadId) continue;
          const current = latest.get(run.agentId);
          if (current === undefined || current.generation < run.generation) {
            latest.set(run.agentId, run);
          }
        }
        return [...latest.values()]
          .sort((left, right) => {
            const leftActive = left.status === "starting" || left.status === "running";
            const rightActive = right.status === "starting" || right.status === "running";
            return leftActive === rightActive
              ? right.createdAt.localeCompare(left.createdAt)
              : leftActive
                ? -1
                : 1;
          })
          .slice(0, limit);
      }),
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
        deliveryState:
          run.deliveryState === "suppressed" || run.deliveryState === "delivered"
            ? run.deliveryState
            : "pending",
        updatedAt: input.updatedAt,
      })),
    markDelivered: (runId) => update(runId, (run) => ({ ...run, deliveryState: "delivered" })),
    markParentDelivered: (parentThreadId) =>
      Effect.sync(() => {
        for (const [runId, run] of rows) {
          if (run.parentThreadId !== parentThreadId) continue;
          rows.set(runId, {
            ...run,
            deliveryState: run.deliveryState === "delivered" ? "delivered" : "suppressed",
          });
        }
      }),
    markDeliveryRetry: (runId) =>
      update(runId, (run) => ({
        ...run,
        deliveryState:
          run.deliveryState === "suppressed" || run.deliveryState === "delivered"
            ? run.deliveryState
            : "pending",
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
            error: NATIVE_CHILD_RESTART_ERROR,
            deliveryState:
              run.deliveryState === "suppressed" || run.deliveryState === "delivered"
                ? run.deliveryState
                : "pending",
            updatedAt: interruptedAt,
          });
          rows.set(runId, next);
          interrupted.push(next);
        }
        return interrupted;
      }),
    insertMessage: (message) =>
      Effect.sync(() => {
        const key = messageKey(message.parentThreadId, message.messageId);
        const existing = messages.get(key);
        if (existing !== undefined) {
          return existing.parentThreadId === message.parentThreadId &&
            existing.senderAgentId === message.senderAgentId &&
            existing.recipientAgentId === message.recipientAgentId &&
            existing.body === message.body
            ? ({ status: "duplicate", message: existing } as const)
            : ({ status: "conflict" } as const);
        }
        const pending = [...messages.values()].filter(
          (candidate) =>
            candidate.recipientAgentId === message.recipientAgentId &&
            candidate.acknowledgedAt === null,
        ).length;
        if (pending >= 100) return { status: "inbox-full" } as const;
        messages.set(key, message);
        return { status: "inserted", message } as const;
      }),
    listPendingMessages: (recipientAgentId, limit) =>
      Effect.sync(() =>
        [...messages.values()]
          .filter(
            (message) =>
              message.recipientAgentId === recipientAgentId && message.acknowledgedAt === null,
          )
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .slice(0, limit),
      ),
    acknowledgeMessage: (input) =>
      Effect.sync(() => {
        const key = messageKey(input.parentThreadId, input.messageId);
        const message = messages.get(key);
        if (
          message === undefined ||
          message.recipientAgentId !== input.recipientAgentId ||
          message.acknowledgedAt !== null
        ) {
          return false;
        }
        messages.set(key, {
          ...message,
          updatedAt: input.acknowledgedAt,
          acknowledgedAt: input.acknowledgedAt,
        });
        return true;
      }),
    markMessageNotified: (input) =>
      Effect.sync(() => {
        const key = messageKey(input.parentThreadId, input.messageId);
        const message = messages.get(key);
        if (message === undefined || message.deliveryState !== "queued") return;
        messages.set(key, {
          ...message,
          deliveryState: "notified",
          deliveryRunId: input.deliveryRunId,
          updatedAt: input.updatedAt,
        });
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
