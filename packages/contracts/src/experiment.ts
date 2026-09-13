import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  THREAD_GOAL_MAX_CHARS,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const THREAD_EXPERIMENT_OBJECTIVE_MAX_CHARS = THREAD_GOAL_MAX_CHARS;
export const THREAD_EXPERIMENT_HYPOTHESIS_MAX_CHARS = 500;
export const THREAD_EXPERIMENT_MAX_APPROVED_FILES = 1_000;
export const THREAD_EXPERIMENT_MAX_CHECKS = 32;
export const THREAD_EXPERIMENT_MAX_ARGV_ITEMS = 128;
export const THREAD_EXPERIMENT_MAX_ARG_CHARS = 8_192;
export const THREAD_EXPERIMENT_MAX_EXPERIMENTS = 1_000;
export const THREAD_EXPERIMENT_MAX_TOTAL_SECONDS = 604_800;
export const THREAD_EXPERIMENT_MAX_COMMAND_SECONDS = 86_400;
export const THREAD_EXPERIMENT_MAX_OUTPUT_BYTES = 10_000_000;
export const THREAD_EXPERIMENT_MAX_FILES_PER_APPLY = 100;
export const THREAD_EXPERIMENT_MAX_APPLY_BYTES = 10_000_000;
export const THREAD_EXPERIMENT_MAX_BYTES_PER_FILE = THREAD_EXPERIMENT_MAX_APPLY_BYTES;
export const THREAD_EXPERIMENT_MAX_TOTAL_APPLY_BYTES = THREAD_EXPERIMENT_MAX_APPLY_BYTES;

const ExperimentIdentifier = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const ExperimentPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));
const ExperimentError = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const ExperimentCount = NonNegativeInt.check(
  Schema.isLessThanOrEqualTo(THREAD_EXPERIMENT_MAX_EXPERIMENTS),
);
const MaxExperiments = PositiveInt.check(
  Schema.isLessThanOrEqualTo(THREAD_EXPERIMENT_MAX_EXPERIMENTS),
);
const MaxTotalSeconds = PositiveInt.check(
  Schema.isLessThanOrEqualTo(THREAD_EXPERIMENT_MAX_TOTAL_SECONDS),
);
const CommandTimeoutSeconds = PositiveInt.check(
  Schema.isLessThanOrEqualTo(THREAD_EXPERIMENT_MAX_COMMAND_SECONDS),
);
const OutputBytes = PositiveInt.check(
  Schema.isLessThanOrEqualTo(THREAD_EXPERIMENT_MAX_OUTPUT_BYTES),
);
const ApplyFiles = PositiveInt.check(
  Schema.isLessThanOrEqualTo(THREAD_EXPERIMENT_MAX_FILES_PER_APPLY),
);
const BytesPerFile = PositiveInt.check(
  Schema.isLessThanOrEqualTo(THREAD_EXPERIMENT_MAX_BYTES_PER_FILE),
);
const TotalApplyBytes = PositiveInt.check(
  Schema.isLessThanOrEqualTo(THREAD_EXPERIMENT_MAX_TOTAL_APPLY_BYTES),
);
const FiniteMetric = Schema.Finite;
const NullableMetric = Schema.NullOr(FiniteMetric);

export const ThreadExperimentObjective = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_EXPERIMENT_OBJECTIVE_MAX_CHARS),
);
export type ThreadExperimentObjective = typeof ThreadExperimentObjective.Type;

export const ThreadExperimentHypothesis = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_EXPERIMENT_HYPOTHESIS_MAX_CHARS),
);
export type ThreadExperimentHypothesis = typeof ThreadExperimentHypothesis.Type;

export const ThreadExperimentMetricDirection = Schema.Literals(["maximize", "minimize"]);
export type ThreadExperimentMetricDirection = typeof ThreadExperimentMetricDirection.Type;

export const ThreadExperimentMetric = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  direction: ThreadExperimentMetricDirection,
  minimumImprovement: FiniteMetric.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ThreadExperimentMetric = typeof ThreadExperimentMetric.Type;

export const ThreadExperimentArgv = Schema.Array(
  Schema.String.check(Schema.isMaxLength(THREAD_EXPERIMENT_MAX_ARG_CHARS)),
).check(Schema.isMinLength(1), Schema.isMaxLength(THREAD_EXPERIMENT_MAX_ARGV_ITEMS));
export type ThreadExperimentArgv = typeof ThreadExperimentArgv.Type;

export const ThreadExperimentEvaluator = Schema.Struct({
  argv: ThreadExperimentArgv,
  metric: ThreadExperimentMetric,
});
export type ThreadExperimentEvaluator = typeof ThreadExperimentEvaluator.Type;

export const ThreadExperimentCheck = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  argv: ThreadExperimentArgv,
});
export type ThreadExperimentCheck = typeof ThreadExperimentCheck.Type;

export const ThreadExperimentLimits = Schema.Struct({
  maxExperiments: MaxExperiments,
  /** Wall-clock campaign horizon from start, including pauses and idle time. */
  maxTotalSeconds: MaxTotalSeconds,
  evaluatorTimeoutSeconds: CommandTimeoutSeconds,
  checkTimeoutSeconds: CommandTimeoutSeconds,
  maxEvaluatorOutputBytes: OutputBytes,
  maxCheckOutputBytes: OutputBytes,
  maxFilesPerApply: ApplyFiles,
  maxBytesPerFile: BytesPerFile,
  maxTotalApplyBytes: TotalApplyBytes,
});
export type ThreadExperimentLimits = typeof ThreadExperimentLimits.Type;

export const ThreadExperimentProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  supported: Schema.Boolean,
  reason: Schema.NullOr(ExperimentError),
}).check(
  Schema.makeFilter(
    (provider) =>
      (provider.supported && provider.reason === null) ||
      (!provider.supported && provider.reason !== null) ||
      "Supported providers have no reason; unsupported providers require one.",
  ),
);
export type ThreadExperimentProvider = typeof ThreadExperimentProvider.Type;

/** Exact server-owned configuration pinned by a one-shot confirmation. */
export const ThreadExperimentPreview = Schema.Struct({
  objective: ThreadExperimentObjective,
  confirmationId: ExperimentIdentifier,
  expiresAt: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  cwd: ExperimentPath,
  branch: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  head: ExperimentIdentifier,
  configDigest: ExperimentIdentifier,
  approvedFiles: Schema.Array(ExperimentPath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THREAD_EXPERIMENT_MAX_APPROVED_FILES),
  ),
  provider: ThreadExperimentProvider,
  evaluator: ThreadExperimentEvaluator,
  checks: Schema.Array(ThreadExperimentCheck).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THREAD_EXPERIMENT_MAX_CHECKS),
  ),
  limits: ThreadExperimentLimits,
});
export type ThreadExperimentPreview = typeof ThreadExperimentPreview.Type;

export const ThreadExperimentPhase = Schema.Literals([
  "ready",
  "baseline",
  "applying",
  "evaluating",
  "keeping",
  "restoring",
  "paused",
  "exhausted",
  "failed",
  "complete",
]);
export type ThreadExperimentPhase = typeof ThreadExperimentPhase.Type;

/** Bounded public progress only. File contents and restoration snapshots stay server-side. */
export const ThreadExperimentSummary = Schema.Struct({
  runId: ExperimentIdentifier,
  configDigest: ExperimentIdentifier,
  phase: ThreadExperimentPhase,
  metric: ThreadExperimentMetric,
  experimentsRun: ExperimentCount,
  experimentsKept: ExperimentCount,
  experimentsRestored: ExperimentCount,
  baselineMetric: NullableMetric,
  bestMetric: NullableMetric,
  lastMetric: NullableMetric,
  /** Wall-clock campaign time consumed since start, including pauses and idle time. */
  elapsedSeconds: FiniteMetric.check(
    Schema.isBetween({
      minimum: 0,
      maximum: THREAD_EXPERIMENT_MAX_TOTAL_SECONDS + THREAD_EXPERIMENT_MAX_COMMAND_SECONDS,
    }),
  ),
  maxExperiments: MaxExperiments,
  maxTotalSeconds: MaxTotalSeconds,
  lastError: Schema.NullOr(ExperimentError),
}).check(
  Schema.makeFilter(
    (summary) =>
      (summary.experimentsRun <= summary.maxExperiments &&
        summary.experimentsKept + summary.experimentsRestored <= summary.experimentsRun) ||
      "Experiment counts must fit the run budget.",
  ),
);
export type ThreadExperimentSummary = typeof ThreadExperimentSummary.Type;

const strict = { parseOptions: { onExcessProperty: "error" } } as const;

export const ThreadExperimentPreviewInput = Schema.Struct({
  threadId: ThreadId,
  objective: ThreadExperimentObjective,
}).annotate(strict);
export type ThreadExperimentPreviewInput = typeof ThreadExperimentPreviewInput.Type;

export const ThreadExperimentStartInput = Schema.Struct({
  threadId: ThreadId,
  objective: ThreadExperimentObjective,
  confirmationId: ExperimentIdentifier,
}).annotate(strict);
export type ThreadExperimentStartInput = typeof ThreadExperimentStartInput.Type;

export const ThreadExperimentGetInput = Schema.Struct({
  threadId: ThreadId,
}).annotate(strict);
export type ThreadExperimentGetInput = typeof ThreadExperimentGetInput.Type;

export const ThreadExperimentErrorReason = Schema.Literals([
  "invalid-objective",
  "unsupported-provider",
  "config-not-found",
  "invalid-config",
  "unsafe-repository",
  "confirmation-expired",
  "confirmation-mismatch",
  "already-running",
  "not-found",
  "conflict",
  "internal",
]);
export type ThreadExperimentErrorReason = typeof ThreadExperimentErrorReason.Type;

export class ThreadExperimentError extends Schema.TaggedError<ThreadExperimentError>()(
  "ThreadExperimentError",
  {
    threadId: ThreadId,
    reason: ThreadExperimentErrorReason,
    message: ExperimentError,
  },
) {}
