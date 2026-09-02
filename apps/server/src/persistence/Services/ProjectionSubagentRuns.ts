import {
  IsoDateTime,
  NonNegativeInt,
  OrchestrationSubagentRun,
  PositiveInt,
  RuntimeTaskId,
  SubagentRunHistoryAvailability,
  SubagentRunStatus,
  SubagentRunTerminalReason,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionSubagentRun = Schema.Struct({
  ...OrchestrationSubagentRun.fields,
  ownerId: Schema.NullOr(Schema.String),
  ownerEpoch: Schema.String,
  nativeRunId: Schema.NullOr(Schema.String),
  activationId: Schema.NullOr(Schema.String),
  /** Phase 1.5 binding evidence; null on capability-absent runs. */
  runBirth: Schema.NullOr(Schema.String),
  firstEventSequence: NonNegativeInt,
  lastEventSequence: NonNegativeInt,
});
export type ProjectionSubagentRun = typeof ProjectionSubagentRun.Type;

export const ReserveSubagentRunNumberInput = Schema.Struct({
  runId: RuntimeTaskId,
  allocatedAt: IsoDateTime,
  ownerId: Schema.NullOr(Schema.String),
  ownerEpoch: Schema.String,
  nativeRunId: Schema.NullOr(Schema.String),
  activationId: Schema.NullOr(Schema.String),
});
export type ReserveSubagentRunNumberInput = typeof ReserveSubagentRunNumberInput.Type;

export const GetProjectionSubagentRunInput = Schema.Struct({ runId: RuntimeTaskId });
export type GetProjectionSubagentRunInput = typeof GetProjectionSubagentRunInput.Type;

export const ListProjectionSubagentRunsInput = Schema.Struct({
  threadId: ThreadId,
  limit: PositiveInt,
  beforeRunNumber: Schema.optional(PositiveInt),
});
export type ListProjectionSubagentRunsInput = typeof ListProjectionSubagentRunsInput.Type;

export const UpdateProjectionSubagentRunInput = Schema.Struct({
  runId: RuntimeTaskId,
  status: SubagentRunStatus,
  terminalReason: Schema.NullOr(SubagentRunTerminalReason),
  title: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  eventSequence: NonNegativeInt,
});
export type UpdateProjectionSubagentRunInput = typeof UpdateProjectionSubagentRunInput.Type;

export const InterruptNonResumableSubagentRunsInput = Schema.Struct({
  interruptedAt: IsoDateTime,
});
export type InterruptNonResumableSubagentRunsInput =
  typeof InterruptNonResumableSubagentRunsInput.Type;

/**
 * Private Phase 1.5 binding facts for one durable run row: what the side
 * store and the binding-result path need, and nothing a public inventory
 * read exposes. `lastTranscriptSequence` is the read/replay watermark — a
 * null value means no finalized item has been observed yet.
 */
export interface ProjectionSubagentRunBinding {
  readonly runId: RuntimeTaskId;
  readonly threadId: ThreadId;
  readonly managerId: string | null;
  readonly managerRunId: string | null;
  readonly activationId: string | null;
  readonly runBirth: string | null;
  readonly historyAvailability: SubagentRunHistoryAvailability;
  readonly lastTranscriptSequence: number | null;
}

export const AdvanceSubagentTranscriptWatermarkInput = Schema.Struct({
  runId: RuntimeTaskId,
  lastTranscriptSequence: PositiveInt,
});
export type AdvanceSubagentTranscriptWatermarkInput =
  typeof AdvanceSubagentTranscriptWatermarkInput.Type;

export interface ProjectionSubagentRunRepositoryShape {
  readonly reserveRunNumber: (
    input: ReserveSubagentRunNumberInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly insertStart: (
    row: ProjectionSubagentRun,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly updateLifecycle: (
    input: UpdateProjectionSubagentRunInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByRunId: (
    input: GetProjectionSubagentRunInput,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof OrchestrationSubagentRun> | null,
    ProjectionRepositoryError
  >;
  readonly listByThreadId: (
    input: ListProjectionSubagentRunsInput,
  ) => Effect.Effect<
    ReadonlyArray<Schema.Schema.Type<typeof OrchestrationSubagentRun>>,
    ProjectionRepositoryError
  >;
  readonly interruptNonResumable: (
    input: InterruptNonResumableSubagentRunsInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  /** Private Phase 1.5 binding read for the transcript side store. */
  readonly getRunBinding: (
    input: GetProjectionSubagentRunInput,
  ) => Effect.Effect<ProjectionSubagentRunBinding | null, ProjectionRepositoryError>;
  /**
   * Advance the read watermark only. Never lowers it and never touches
   * lifecycle, terminal, identity, or binding columns.
   */
  readonly advanceTranscriptWatermark: (
    input: AdvanceSubagentTranscriptWatermarkInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionSubagentRunRepository extends Context.Service<
  ProjectionSubagentRunRepository,
  ProjectionSubagentRunRepositoryShape
>()("t3/persistence/Services/ProjectionSubagentRuns/ProjectionSubagentRunRepository") {}
