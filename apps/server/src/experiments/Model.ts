import * as Schema from "effect/Schema";

export const MAX_CONFIG_BYTES = 1_000_000;
export const MAX_LEDGER_RECORD_BYTES = 64_000;
export const CONFIRMATION_TTL_MS = 5 * 60_000;

const NonEmpty = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty());
const BoundedObjective = NonEmpty.check(Schema.isMaxLength(1_024));
const BoundedHypothesis = NonEmpty.check(Schema.isMaxLength(500));
const MetricName = NonEmpty.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_.-]+$/));
const Arg = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8_192));
const Argv = Schema.Array(Arg).check(Schema.isMinLength(1), Schema.isMaxLength(128));
const SafeInteger = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));
const Sha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i));
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const ExperimentEvaluator = Schema.Struct({
  argv: Argv,
  metric: MetricName,
  direction: Schema.Literals(["lower", "higher"]),
  minimumImprovement: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ExperimentEvaluator = typeof ExperimentEvaluator.Type;

export const ExperimentLimits = Schema.Struct({
  maxExperiments: SafeInteger(1, 1_000),
  maxApplyBytes: SafeInteger(1, 10_000_000),
  maxOutputBytes: SafeInteger(1, 10_000_000),
  evaluatorTimeoutSeconds: SafeInteger(1, 86_400),
  checkTimeoutSeconds: SafeInteger(1, 86_400),
  maxTotalSeconds: SafeInteger(1, 604_800),
});
export type ExperimentLimits = typeof ExperimentLimits.Type;

export const ExperimentConfig = Schema.Struct({
  version: Schema.Literal(1),
  branch: NonEmpty.check(Schema.isMaxLength(512)),
  files: Schema.Array(NonEmpty.check(Schema.isMaxLength(4_096))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1_000),
  ),
  evaluator: ExperimentEvaluator,
  checks: Schema.Array(Argv).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  limits: ExperimentLimits,
  protectedBranches: Schema.optional(
    Schema.Array(NonEmpty.check(Schema.isMaxLength(512))).check(Schema.isMaxLength(128)),
  ),
});
export type ExperimentConfig = typeof ExperimentConfig.Type;

export const FileSnapshot = Schema.Struct({
  path: NonEmpty,
  contentBase64: Schema.String,
  mode: SafeInteger(0, 0o777),
  hash: Sha,
});
export type FileSnapshot = typeof FileSnapshot.Type;

export const PendingExperiment = Schema.Struct({
  id: NonEmpty,
  hypothesis: BoundedHypothesis,
  headBefore: Sha,
  snapshots: Schema.Array(FileSnapshot).check(Schema.isMinLength(1), Schema.isMaxLength(1_000)),
  expectedHashes: Schema.Record(NonEmpty, Sha),
  writtenPaths: Schema.Array(NonEmpty),
  restoredPaths: Schema.Array(NonEmpty),
  metric: Schema.NullOr(Schema.Finite),
  metrics: Schema.NullOr(Schema.Record(MetricName, Schema.Finite)),
});
export type PendingExperiment = typeof PendingExperiment.Type;

export const ExperimentPhase = Schema.Literals([
  "baseline",
  "ready",
  "applying",
  "applied",
  "evaluating",
  "committing",
  "restoring",
  "paused",
  "exhausted",
  "failed",
  "completed",
]);
export type ExperimentPhase = typeof ExperimentPhase.Type;

export const ExperimentProfile = Schema.Struct({
  version: Schema.Literal(1),
  runId: NonEmpty,
  threadId: NonEmpty,
  goalGeneration: SafeInteger(1, Number.MAX_SAFE_INTEGER),
  objective: BoundedObjective,
  phase: ExperimentPhase,
  armed: Schema.Boolean,
  cwd: NonEmpty,
  branch: NonEmpty,
  head: Sha,
  providerInstanceId: NonEmpty,
  providerSessionId: NonEmpty,
  providerDriver: NonEmpty,
  providerSessionActive: Schema.Boolean,
  config: ExperimentConfig,
  configDigest: Digest,
  baselineMetric: Schema.NullOr(Schema.Finite),
  bestMetric: Schema.NullOr(Schema.Finite),
  lastMetric: Schema.NullOr(Schema.Finite),
  experimentsRun: SafeInteger(0, 1_000),
  experimentsKept: SafeInteger(0, 1_000),
  experimentsRestored: SafeInteger(0, 1_000),
  commandSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: NonEmpty,
  deadlineAt: NonEmpty,
  updatedAt: NonEmpty,
  pending: Schema.NullOr(PendingExperiment),
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type ExperimentProfile = typeof ExperimentProfile.Type;

export interface ExperimentThreadContext {
  readonly threadId: string;
  readonly cwd: string;
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly providerDriver: string;
  readonly providerSupported: boolean;
  readonly unsupportedReason?: string;
  readonly idle: boolean;
  readonly pendingChildRun: boolean;
}

export interface ExperimentConfirmation {
  readonly threadId: string;
  readonly objective: string;
  readonly confirmationId: string;
  readonly expiresAt: string;
  readonly cwd: string;
  readonly branch: string;
  readonly head: string;
  readonly configDigest: string;
  readonly config: ExperimentConfig;
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly providerDriver: string;
}

export interface ExperimentIdentity {
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly providerSessionId: string;
  readonly runId: string;
}

export interface ExperimentChange {
  readonly path: string;
  readonly content: string;
}

export class ExperimentError extends Schema.TaggedErrorClass<ExperimentError>()("ExperimentError", {
  code: Schema.Literals([
    "invalid_config",
    "unsafe_repository",
    "unsupported_provider",
    "thread_busy",
    "confirmation_invalid",
    "authentication_failed",
    "invalid_phase",
    "limits_exhausted",
    "evaluation_failed",
    "external_drift",
    "persistence_failed",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const decodeExperimentConfig = (value: unknown): ExperimentConfig =>
  Schema.decodeUnknownSync(ExperimentConfig)(value, { onExcessProperty: "error" });

export const decodeExperimentProfile = (value: unknown): ExperimentProfile =>
  Schema.decodeUnknownSync(ExperimentProfile)(value, { onExcessProperty: "error" });
