import * as Schema from "effect/Schema";

export type { ExperimentIdentity as ExperimentMcpIdentity } from "../experiments/Model.ts";

export class ExperimentMcpError extends Schema.TaggedErrorClass<ExperimentMcpError>()(
  "ExperimentMcpError",
  {
    code: Schema.Literals([
      "PROVIDER_EXPERIMENT_UNAUTHORIZED",
      "PROVIDER_EXPERIMENT_UNSUPPORTED",
      "EXPERIMENT_INVALID_PATH",
      "EXPERIMENT_INVALID_REQUEST",
      "EXPERIMENT_UNAVAILABLE",
    ]),
    message: Schema.String,
  },
) {}

const NullableMetric = Schema.NullOr(Schema.Finite);
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));

export const ExperimentSummary = Schema.Struct({
  runId: Schema.String,
  configDigest: Schema.String,
  phase: Schema.String,
  metric: NullableMetric,
  experimentsRun: NonNegativeInt,
  experimentsKept: NonNegativeInt,
  experimentsRestored: NonNegativeInt,
  baselineMetric: NullableMetric,
  bestMetric: NullableMetric,
  lastMetric: NullableMetric,
  elapsedCommandSeconds: NonNegativeFinite,
  maxExperiments: PositiveInt,
  maxTotalSeconds: PositiveFinite,
  lastError: Schema.NullOr(Schema.String),
});
export type ExperimentSummary = typeof ExperimentSummary.Type;

export const ExperimentFileList = Schema.Struct({
  files: Schema.Array(Schema.String),
});
export type ExperimentFileList = typeof ExperimentFileList.Type;

export const ExperimentReadFileInput = Schema.Struct({
  path: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_024),
    Schema.isPattern(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+$/u),
  ),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 }))),
});
export type ExperimentReadFileInput = typeof ExperimentReadFileInput.Type;

export const ExperimentReadFileResult = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
});
export type ExperimentReadFileResult = typeof ExperimentReadFileResult.Type;

export const ExperimentApplyInput = Schema.Struct({
  hypothesis: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  changes: Schema.Array(
    Schema.Struct({
      path: ExperimentReadFileInput.fields.path,
      content: Schema.String,
    }),
  ).check(Schema.isMinLength(1)),
});
export type ExperimentApplyInput = typeof ExperimentApplyInput.Type;

export const ExperimentApplyResult = Schema.Struct({
  candidateId: Schema.String,
  files: Schema.Array(Schema.String),
});
export type ExperimentApplyResult = typeof ExperimentApplyResult.Type;

export const ExperimentEvaluateResult = Schema.Struct({
  outcome: Schema.Literals(["baseline", "kept", "restored", "failed"]),
  metric: NullableMetric,
  metrics: Schema.Record(Schema.String, Schema.Finite),
  commit: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});
export type ExperimentEvaluateResult = typeof ExperimentEvaluateResult.Type;
