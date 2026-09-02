import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationSubagentRun,
  PositiveInt,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  SubagentRunControlAvailability,
  SubagentRunHistoryAvailability,
  SubagentRunRuntimeFamily,
  SubagentRunStatus,
  SubagentRunTerminalReason,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  AdvanceSubagentTranscriptWatermarkInput,
  GetProjectionSubagentRunInput,
  InterruptNonResumableSubagentRunsInput,
  ListProjectionSubagentRunsInput,
  ProjectionSubagentRun,
  ProjectionSubagentRunRepository,
  ReserveSubagentRunNumberInput,
  UpdateProjectionSubagentRunInput,
  type ProjectionSubagentRunRepositoryShape,
} from "../Services/ProjectionSubagentRuns.ts";

const RunNumberRow = Schema.Struct({ runNumber: PositiveInt });
const RunIdRow = Schema.Struct({ runId: RuntimeTaskId });
const RunBindingRow = Schema.Struct({
  runId: RuntimeTaskId,
  threadId: ThreadId,
  managerId: Schema.NullOr(Schema.String),
  managerRunId: Schema.NullOr(Schema.String),
  activationId: Schema.NullOr(Schema.String),
  runBirth: Schema.NullOr(Schema.String),
  historyAvailability: SubagentRunHistoryAvailability,
  lastTranscriptSequence: Schema.NullOr(PositiveInt),
});
const ProjectionSubagentRunDbRow = Schema.Struct({
  runId: RuntimeTaskId,
  runNumber: PositiveInt,
  threadId: ThreadId,
  parentRunId: Schema.NullOr(RuntimeTaskId),
  runtimeFamily: SubagentRunRuntimeFamily,
  harness: Schema.NullOr(TrimmedNonEmptyString),
  provider: ProviderDriverKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  model: Schema.NullOr(TrimmedNonEmptyString),
  effort: Schema.NullOr(TrimmedNonEmptyString),
  title: Schema.NullOr(TrimmedNonEmptyString),
  summary: Schema.NullOr(TrimmedNonEmptyString),
  status: SubagentRunStatus,
  terminalReason: Schema.NullOr(SubagentRunTerminalReason),
  controlAvailability: SubagentRunControlAvailability,
  historyAvailability: SubagentRunHistoryAvailability,
  canSteer: Schema.Number,
  canCancel: Schema.Number,
  canResume: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  terminalAt: Schema.NullOr(IsoDateTime),
  firstEventSequence: NonNegativeInt,
  lastEventSequence: NonNegativeInt,
});

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function toPublicRun(row: typeof ProjectionSubagentRunDbRow.Type) {
  return OrchestrationSubagentRun.make({
    runId: row.runId,
    runNumber: row.runNumber,
    threadId: row.threadId,
    parentRunId: row.parentRunId,
    runtimeFamily: row.runtimeFamily,
    harness: row.harness,
    provider: row.provider,
    providerInstanceId: row.providerInstanceId,
    model: row.model,
    effort: row.effort,
    title: row.title,
    summary: row.summary,
    status: row.status,
    terminalReason: row.terminalReason,
    controlAvailability: row.controlAvailability,
    historyAvailability: row.historyAvailability,
    capabilities: {
      steer: row.canSteer === 1,
      cancel: row.canCancel === 1,
      resume: row.canResume === 1,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    terminalAt: row.terminalAt,
  });
}

const makeProjectionSubagentRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const reserveRunNumberRow = SqlSchema.findOne({
    Request: ReserveSubagentRunNumberInput,
    Result: RunNumberRow,
    execute: ({ runId, allocatedAt, ownerId, ownerEpoch, nativeRunId, activationId }) => sql`
      INSERT INTO subagent_run_number_reservations (
        run_id,
        allocated_at,
        owner_id,
        owner_epoch,
        native_run_id,
        activation_id
      )
      VALUES (${runId}, ${allocatedAt}, ${ownerId}, ${ownerEpoch}, ${nativeRunId}, ${activationId})
      ON CONFLICT (run_id) DO UPDATE SET run_id = excluded.run_id
      RETURNING run_number AS "runNumber"
    `,
  });

  const insertStartRow = SqlSchema.void({
    Request: ProjectionSubagentRun,
    execute: (row) => sql`
      INSERT INTO projection_subagent_runs (
        run_id,
        run_number,
        thread_id,
        parent_run_id,
        runtime_family,
        harness,
        provider,
        provider_instance_id,
        owner_id,
        owner_epoch,
        native_run_id,
        activation_id,
        run_birth,
        model,
        effort,
        title,
        summary,
        status,
        terminal_reason,
        control_availability,
        history_availability,
        can_steer,
        can_cancel,
        can_resume,
        created_at,
        updated_at,
        terminal_at,
        first_event_sequence,
        last_event_sequence
      ) SELECT
        ${row.runId},
        ${row.runNumber},
        ${row.threadId},
        ${row.parentRunId},
        ${row.runtimeFamily},
        ${row.harness},
        ${row.provider},
        ${row.providerInstanceId},
        reservation.owner_id,
        reservation.owner_epoch,
        reservation.native_run_id,
        reservation.activation_id,
        ${row.runBirth},
        ${row.model},
        ${row.effort},
        ${row.title},
        ${row.summary},
        ${row.status},
        ${row.terminalReason},
        ${row.controlAvailability},
        ${row.historyAvailability},
        ${row.capabilities.steer ? 1 : 0},
        ${row.capabilities.cancel ? 1 : 0},
        ${row.capabilities.resume ? 1 : 0},
        ${row.createdAt},
        ${row.updatedAt},
        ${row.terminalAt},
        ${row.firstEventSequence},
        ${row.lastEventSequence}
      FROM subagent_run_number_reservations AS reservation
      WHERE reservation.run_id = ${row.runId}
        AND reservation.run_number = ${row.runNumber}
      ON CONFLICT (run_id) DO NOTHING
    `,
  });

  const updateLifecycleRow = SqlSchema.void({
    Request: UpdateProjectionSubagentRunInput,
    execute: (input) => sql`
      UPDATE projection_subagent_runs
      SET
        status = ${input.status},
        terminal_reason = CASE
          WHEN ${input.status} IN ('done', 'error', 'cancelled', 'interrupted')
            THEN COALESCE(${input.terminalReason}, terminal_reason)
          ELSE terminal_reason
        END,
        title = COALESCE(${input.title}, title),
        model = COALESCE(${input.model}, model),
        effort = COALESCE(${input.effort}, effort),
        summary = COALESCE(${input.summary}, summary),
        control_availability = CASE
          WHEN ${input.status} IN ('done', 'error', 'cancelled', 'interrupted')
            AND control_availability = 'owner-routed'
            THEN 'read-only'
          ELSE control_availability
        END,
        updated_at = ${input.updatedAt},
        terminal_at = CASE
          WHEN ${input.status} IN ('done', 'error', 'cancelled', 'interrupted')
            THEN COALESCE(terminal_at, ${input.updatedAt})
          ELSE terminal_at
        END,
        last_event_sequence = ${input.eventSequence}
      WHERE run_id = ${input.runId}
        AND status IN ('queued', 'active', 'cancelling')
        AND last_event_sequence < ${input.eventSequence}
    `,
  });

  const getRunRow = SqlSchema.findOneOption({
    Request: GetProjectionSubagentRunInput,
    Result: ProjectionSubagentRunDbRow,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId",
        run_number AS "runNumber",
        thread_id AS "threadId",
        parent_run_id AS "parentRunId",
        runtime_family AS "runtimeFamily",
        harness,
        provider,
        provider_instance_id AS "providerInstanceId",
        model,
        effort,
        title,
        summary,
        status,
        terminal_reason AS "terminalReason",
        control_availability AS "controlAvailability",
        history_availability AS "historyAvailability",
        can_steer AS "canSteer",
        can_cancel AS "canCancel",
        can_resume AS "canResume",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        terminal_at AS "terminalAt",
        first_event_sequence AS "firstEventSequence",
        last_event_sequence AS "lastEventSequence"
      FROM projection_subagent_runs
      WHERE run_id = ${runId}
    `,
  });

  const listRunRows = SqlSchema.findAll({
    Request: ListProjectionSubagentRunsInput,
    Result: ProjectionSubagentRunDbRow,
    execute: ({ threadId, limit, beforeRunNumber }) => sql`
      SELECT
        run_id AS "runId",
        run_number AS "runNumber",
        thread_id AS "threadId",
        parent_run_id AS "parentRunId",
        runtime_family AS "runtimeFamily",
        harness,
        provider,
        provider_instance_id AS "providerInstanceId",
        model,
        effort,
        title,
        summary,
        status,
        terminal_reason AS "terminalReason",
        control_availability AS "controlAvailability",
        history_availability AS "historyAvailability",
        can_steer AS "canSteer",
        can_cancel AS "canCancel",
        can_resume AS "canResume",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        terminal_at AS "terminalAt",
        first_event_sequence AS "firstEventSequence",
        last_event_sequence AS "lastEventSequence"
      FROM projection_subagent_runs
      WHERE thread_id = ${threadId}
        ${beforeRunNumber === undefined ? sql`` : sql`AND run_number < ${beforeRunNumber}`}
      ORDER BY
        CASE WHEN status IN ('queued', 'active', 'cancelling') THEN 0 ELSE 1 END ASC,
        run_number DESC
      LIMIT ${limit}
    `,
  });

  const interruptRows = SqlSchema.findAll({
    Request: InterruptNonResumableSubagentRunsInput,
    Result: RunIdRow,
    execute: ({ interruptedAt }) => sql`
      UPDATE projection_subagent_runs
      SET
        status = 'interrupted',
        terminal_reason = 'server-restart',
        control_availability = CASE
          WHEN control_availability = 'owner-routed' THEN 'read-only'
          ELSE control_availability
        END,
        updated_at = ${interruptedAt},
        terminal_at = ${interruptedAt}
      WHERE status IN ('queued', 'active', 'cancelling')
        AND can_resume = 0
      RETURNING run_id AS "runId"
    `,
  });

  // Private Phase 1.5 binding read: complete producer/T3 tuple plus run-birth
  // and watermark columns only. Never exposes transcript content.
  const getBindingRow = SqlSchema.findOneOption({
    Request: GetProjectionSubagentRunInput,
    Result: RunBindingRow,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId",
        thread_id AS "threadId",
        owner_id AS "managerId",
        native_run_id AS "managerRunId",
        activation_id AS "activationId",
        run_birth AS "runBirth",
        history_availability AS "historyAvailability",
        last_transcript_sequence AS "lastTranscriptSequence"
      FROM projection_subagent_runs
      WHERE run_id = ${runId}
    `,
  });

  // Monotone watermark advance: only last_transcript_sequence moves. No
  // lifecycle, terminal, identity, or provenance column is writable here.
  const advanceWatermarkRow = SqlSchema.void({
    Request: AdvanceSubagentTranscriptWatermarkInput,
    execute: ({ runId, lastTranscriptSequence }) => sql`
      UPDATE projection_subagent_runs
      SET last_transcript_sequence = MAX(
        COALESCE(last_transcript_sequence, 0),
        ${lastTranscriptSequence}
      )
      WHERE run_id = ${runId}
    `,
  });

  const reserveRunNumber: ProjectionSubagentRunRepositoryShape["reserveRunNumber"] = (input) =>
    reserveRunNumberRow(input).pipe(
      Effect.map((row) => row.runNumber),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSubagentRunRepository.reserveRunNumber:query",
          "ProjectionSubagentRunRepository.reserveRunNumber:decodeRow",
        ),
      ),
    );

  const insertStart: ProjectionSubagentRunRepositoryShape["insertStart"] = (row) =>
    insertStartRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSubagentRunRepository.insertStart:query",
          "ProjectionSubagentRunRepository.insertStart:encodeRequest",
        ),
      ),
    );

  const updateLifecycle: ProjectionSubagentRunRepositoryShape["updateLifecycle"] = (input) =>
    updateLifecycleRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSubagentRunRepository.updateLifecycle:query",
          "ProjectionSubagentRunRepository.updateLifecycle:encodeRequest",
        ),
      ),
    );

  const getByRunId: ProjectionSubagentRunRepositoryShape["getByRunId"] = (input) =>
    getRunRow(input).pipe(
      Effect.map((row) => Option.match(row, { onNone: () => null, onSome: toPublicRun })),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSubagentRunRepository.getByRunId:query",
          "ProjectionSubagentRunRepository.getByRunId:decodeRow",
        ),
      ),
    );

  const listByThreadId: ProjectionSubagentRunRepositoryShape["listByThreadId"] = (input) =>
    listRunRows(input).pipe(
      Effect.map((rows) => rows.map(toPublicRun)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSubagentRunRepository.listByThreadId:query",
          "ProjectionSubagentRunRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const interruptNonResumable: ProjectionSubagentRunRepositoryShape["interruptNonResumable"] = (
    input,
  ) =>
    interruptRows(input).pipe(
      Effect.map((rows) => rows.length),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSubagentRunRepository.interruptNonResumable:query",
          "ProjectionSubagentRunRepository.interruptNonResumable:decodeRows",
        ),
      ),
    );

  const getRunBinding: ProjectionSubagentRunRepositoryShape["getRunBinding"] = (input) =>
    getBindingRow(input).pipe(
      Effect.map((row) => Option.match(row, { onNone: () => null, onSome: (binding) => binding })),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSubagentRunRepository.getRunBinding:query",
          "ProjectionSubagentRunRepository.getRunBinding:decodeRow",
        ),
      ),
    );

  const advanceTranscriptWatermark: ProjectionSubagentRunRepositoryShape["advanceTranscriptWatermark"] =
    (input) =>
      advanceWatermarkRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSubagentRunRepository.advanceTranscriptWatermark:query",
            "ProjectionSubagentRunRepository.advanceTranscriptWatermark:encodeRequest",
          ),
        ),
      );

  return {
    reserveRunNumber,
    insertStart,
    updateLifecycle,
    getByRunId,
    listByThreadId,
    interruptNonResumable,
    getRunBinding,
    advanceTranscriptWatermark,
  } satisfies ProjectionSubagentRunRepositoryShape;
});

export const ProjectionSubagentRunRepositoryLive = Layer.effect(
  ProjectionSubagentRunRepository,
  makeProjectionSubagentRunRepository,
);
