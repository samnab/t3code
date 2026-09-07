import { randomUUID } from "node:crypto";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadExperimentPreview,
  type ThreadExperimentSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ThreadExperimentStore } from "../persistence/ThreadExperiments.ts";
import {
  CONFIRMATION_TTL_MS,
  ExperimentError,
  type ExperimentChange,
  type ExperimentConfirmation,
  type ExperimentConfig,
  type ExperimentIdentity,
  type ExperimentPhase,
  type ExperimentProfile,
  type ExperimentThreadContext,
  type PendingExperiment,
} from "./Model.ts";
import { ExperimentProcessRegistry, type BoundedProcessResult } from "./Process.ts";
import {
  appendLedger,
  assertClean,
  assertConfigDigest,
  assertFileMatches,
  assertRepository,
  canonicalRepositoryPath,
  changedPaths,
  commitCandidate,
  currentHead,
  fileHash,
  git,
  hashContent,
  normalizeApprovedPath,
  readApprovedFile,
  readConfig,
  repositoryPathsEqual,
  resolveApprovedFile,
  restoreSnapshot,
  setEquals,
  snapshotFiles,
  stagedPaths,
  unstageCandidate,
  writeFileAtomically,
} from "./Repository.ts";

const TERMINAL_PHASES = new Set<ExperimentPhase>(["exhausted", "failed", "completed"]);
const RECOVERY_PHASES = new Set<ExperimentPhase>([
  "applying",
  "applied",
  "evaluating",
  "committing",
  "restoring",
]);

const MetricsOutput = Schema.Struct({
  metrics: Schema.Record(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,64}$/)),
    Schema.Finite,
  ),
});
const decodeMetricsOutput = Schema.decodeUnknownSync(MetricsOutput);
const Hypothesis = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(500),
);
const decodeHypothesis = Schema.decodeUnknownSync(Hypothesis);
const Objective = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(1_024),
);
const decodeObjective = Schema.decodeUnknownSync(Objective);

function error(
  code: ConstructorParameters<typeof ExperimentError>[0]["code"],
  message: string,
  cause?: unknown,
): ExperimentError {
  return new ExperimentError({ code, message, ...(cause === undefined ? {} : { cause }) });
}

function asExperimentError(cause: unknown, fallback: string): ExperimentError {
  return cause instanceof ExperimentError ? cause : error("evaluation_failed", fallback, cause);
}

function repositoryEffect<A>(operation: string, run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => asExperimentError(cause, `Experiment repository failed during ${operation}.`),
  });
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function elapsedSeconds(profile: ExperimentProfile, nowMs: number): number {
  return Math.max(0, Math.min((nowMs - Date.parse(profile.createdAt)) / 1_000, 691_200));
}

export function publicSummary(
  profile: ExperimentProfile,
  nowMs = Date.now(),
): ThreadExperimentSummary {
  const phase: ThreadExperimentSummary["phase"] =
    profile.phase === "applied"
      ? "applying"
      : profile.phase === "committing"
        ? "keeping"
        : profile.phase === "completed"
          ? "complete"
          : profile.phase;
  return {
    runId: profile.runId,
    configDigest: profile.configDigest,
    phase,
    metric: {
      name: profile.config.evaluator.metric,
      direction: profile.config.evaluator.direction === "higher" ? "maximize" : "minimize",
      minimumImprovement: profile.config.evaluator.minimumImprovement,
    },
    experimentsRun: profile.experimentsRun,
    experimentsKept: profile.experimentsKept,
    experimentsRestored: profile.experimentsRestored,
    baselineMetric: profile.baselineMetric,
    bestMetric: profile.bestMetric,
    lastMetric: profile.lastMetric,
    elapsedSeconds: elapsedSeconds(profile, nowMs),
    maxExperiments: profile.config.limits.maxExperiments,
    maxTotalSeconds: profile.config.limits.maxTotalSeconds,
    lastError: profile.lastError,
  };
}

export function toolSummary(profile: ExperimentProfile): ExperimentToolSummary {
  return {
    runId: profile.runId,
    configDigest: profile.configDigest,
    phase: profile.phase,
    metric: profile.lastMetric,
    experimentsRun: profile.experimentsRun,
    experimentsKept: profile.experimentsKept,
    experimentsRestored: profile.experimentsRestored,
    baselineMetric: profile.baselineMetric,
    bestMetric: profile.bestMetric,
    lastMetric: profile.lastMetric,
    elapsedCommandSeconds: profile.commandSeconds,
    maxExperiments: profile.config.limits.maxExperiments,
    maxTotalSeconds: profile.config.limits.maxTotalSeconds,
    lastError: profile.lastError,
  };
}

export interface ExperimentCoordinatorShape {
  readonly resolveThread: (
    threadId: string,
  ) => Effect.Effect<ExperimentThreadContext, ExperimentError>;
  readonly activateGoal: (input: {
    readonly threadId: string;
    readonly objective: string;
    readonly summary: ThreadExperimentSummary;
  }) => Effect.Effect<void, ExperimentError>;
  readonly startProvider: (input: {
    readonly threadId: string;
    readonly providerInstanceId: string;
    readonly cwd: string;
    readonly runId: string;
    readonly generation: number;
  }) => Effect.Effect<ExperimentIdentity, ExperimentError>;
  readonly stopProvider: (input: {
    readonly threadId: string;
    readonly runId: string;
  }) => Effect.Effect<void, ExperimentError>;
  readonly syncSummary: (input: {
    readonly threadId: string;
    readonly summary: ThreadExperimentSummary;
  }) => Effect.Effect<void, ExperimentError>;
  readonly holdGoal: (input: {
    readonly threadId: string;
    readonly action: "pause" | "block" | "complete";
    readonly reason: string;
  }) => Effect.Effect<void, ExperimentError>;
}

/** Provider-specific support and live session identity stay at the adapter boundary. */
export class ExperimentCoordinator extends Context.Service<
  ExperimentCoordinator,
  ExperimentCoordinatorShape
>()("t3/experiments/ExperimentCoordinator") {}

export interface ExperimentEvaluationResult {
  readonly outcome: "baseline" | "kept" | "restored" | "failed";
  readonly metric: number | null;
  readonly metrics: Readonly<Record<string, number>>;
  readonly commit: string | null;
  readonly reason: string;
}

export interface ExperimentToolSummary {
  readonly runId: string;
  readonly configDigest: string;
  readonly phase: string;
  readonly metric: number | null;
  readonly experimentsRun: number;
  readonly experimentsKept: number;
  readonly experimentsRestored: number;
  readonly baselineMetric: number | null;
  readonly bestMetric: number | null;
  readonly lastMetric: number | null;
  readonly elapsedCommandSeconds: number;
  readonly maxExperiments: number;
  readonly maxTotalSeconds: number;
  readonly lastError: string | null;
}

export interface ExperimentServiceShape {
  readonly preview: (input: {
    readonly threadId: string;
    readonly objective: string;
  }) => Effect.Effect<ThreadExperimentPreview, ExperimentError>;
  readonly start: (input: {
    readonly threadId: string;
    readonly objective: string;
    readonly confirmationId: string;
  }) => Effect.Effect<ThreadExperimentSummary, ExperimentError>;
  readonly get: (input: {
    readonly threadId: string;
  }) => Effect.Effect<ThreadExperimentSummary | null, ExperimentError>;
  readonly status: (
    identity: ExperimentIdentity,
  ) => Effect.Effect<ExperimentToolSummary, ExperimentError>;
  readonly listFiles: (
    identity: ExperimentIdentity,
  ) => Effect.Effect<{ readonly files: ReadonlyArray<string> }, ExperimentError>;
  readonly readFile: (
    input: ExperimentIdentity & { readonly path: string },
  ) => Effect.Effect<{ readonly path: string; readonly content: string }, ExperimentError>;
  readonly apply: (
    input: ExperimentIdentity & {
      readonly hypothesis: string;
      readonly changes: ReadonlyArray<ExperimentChange>;
    },
  ) => Effect.Effect<
    { readonly candidateId: string; readonly files: ReadonlyArray<string> },
    ExperimentError
  >;
  readonly evaluate: (
    identity: ExperimentIdentity,
  ) => Effect.Effect<ExperimentEvaluationResult, ExperimentError>;
  readonly settle: (input: {
    readonly threadId: string;
    readonly reason: string;
    readonly terminal: "pause" | "block" | "complete" | "clear" | "capped";
  }) => Effect.Effect<void, ExperimentError>;
  readonly resume: (threadId: string) => Effect.Effect<ThreadExperimentSummary, ExperimentError>;
  readonly canContinue: (threadId: string) => Effect.Effect<boolean, ExperimentError>;
  readonly recoverAll: () => Effect.Effect<void, never>;
}

export class ExperimentService extends Context.Service<ExperimentService, ExperimentServiceShape>()(
  "t3/experiments/ExperimentService",
) {}

interface CommandEvaluation {
  readonly passed: boolean;
  readonly metrics: Readonly<Record<string, number>> | null;
  readonly metric: number | null;
  readonly reason: string;
  readonly output: string;
}

function outputTail(result: BoundedProcessResult): string {
  return `${result.stdout}\n${result.stderr}`.trim().slice(-4_000);
}

function parseMetrics(stdout: string, metricName: string): Readonly<Record<string, number>> {
  try {
    const decoded = decodeMetricsOutput(JSON.parse(stdout.trim()), { onExcessProperty: "error" });
    if (
      ["__proto__", "constructor", "prototype"].some((name) => Object.hasOwn(decoded.metrics, name))
    ) {
      throw new Error("Evaluator returned a reserved metric name.");
    }
    if (!Object.hasOwn(decoded.metrics, metricName)) {
      throw new Error(`Evaluator did not return configured metric ${JSON.stringify(metricName)}.`);
    }
    return decoded.metrics;
  } catch (cause) {
    throw error(
      "evaluation_failed",
      'Evaluator stdout must be exactly one JSON object: {"metrics":{"name":number}}.',
      cause,
    );
  }
}

function qualifies(config: ExperimentConfig, metric: number, best: number): boolean {
  const delta = config.evaluator.direction === "lower" ? best - metric : metric - best;
  return delta > 0 && delta >= config.evaluator.minimumImprovement;
}

export const make = Effect.gen(function* () {
  const store = yield* ThreadExperimentStore;
  const coordinator = yield* ExperimentCoordinator;
  const processes = new ExperimentProcessRegistry();
  const confirmations = new Map<string, ExperimentConfirmation>();
  const threadLocks = new Map<string, Semaphore.Semaphore>();
  const startLock = Semaphore.makeUnsafe(1);

  const withThreadLock = <A, R>(threadId: string, effect: Effect.Effect<A, ExperimentError, R>) => {
    let lock = threadLocks.get(threadId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      threadLocks.set(threadId, lock);
    }
    return lock.withPermits(1)(effect);
  };

  const ledger = (profile: ExperimentProfile, entry: Readonly<Record<string, unknown>>) =>
    Effect.tryPromise({
      try: () =>
        appendLedger(profile.cwd, profile.runId, {
          at: profile.updatedAt,
          runId: profile.runId,
          threadId: profile.threadId,
          ...entry,
        }),
      catch: (cause) => asExperimentError(cause, "Could not append the experiment ledger."),
    });

  const save = Effect.fn("ExperimentService.save")(function* (
    profile: ExperimentProfile,
    options: { readonly sync?: boolean } = {},
  ) {
    const currentMs = yield* Clock.currentTimeMillis;
    const next = { ...profile, updatedAt: nowIso(currentMs) } satisfies ExperimentProfile;
    yield* store.save(next);
    if (options.sync !== false) {
      yield* coordinator.syncSummary({
        threadId: next.threadId,
        summary: publicSummary(next, currentMs),
      });
    }
    return next;
  });

  const exhaust = Effect.fn("ExperimentService.exhaust")(function* (
    profile: ExperimentProfile,
    reason: string,
  ) {
    yield* Effect.tryPromise({
      try: () => processes.cancel(profile.runId),
      catch: (cause) => asExperimentError(cause, "Could not stop experiment processes."),
    });
    if (profile.providerSessionActive) {
      yield* coordinator.stopProvider({ threadId: profile.threadId, runId: profile.runId });
    }
    if (profile.pending !== null) {
      return yield* restore(
        { ...profile, armed: false, providerSessionActive: false },
        null,
        reason,
      ).pipe(
        Effect.catch((cause) =>
          failClosed(profile, cause).pipe(Effect.flatMap((failure) => Effect.fail(failure))),
        ),
      );
    }
    const next = yield* save({
      ...profile,
      phase: "exhausted",
      armed: false,
      providerSessionActive: false,
      lastError: reason,
    });
    yield* ledger(next, { type: "exhausted", reason });
    yield* coordinator.holdGoal({ threadId: next.threadId, action: "pause", reason });
    return next;
  });

  const enforceLimits = Effect.fn("ExperimentService.enforceLimits")(function* (
    profile: ExperimentProfile,
  ) {
    if (TERMINAL_PHASES.has(profile.phase)) return profile;
    const currentMs = yield* Clock.currentTimeMillis;
    if (
      profile.experimentsRun >= profile.config.limits.maxExperiments ||
      currentMs >= Date.parse(profile.deadlineAt)
    ) {
      return yield* exhaust(profile, "Experiment limits reached.");
    }
    return profile;
  });

  const assertLiveContext = Effect.fn("ExperimentService.assertLiveContext")(function* (
    profile: ExperimentProfile,
    options: { readonly session?: boolean } = {},
  ) {
    const context = yield* coordinator.resolveThread(profile.threadId);
    const cwd = yield* repositoryEffect("canonicalize live repository", async () =>
      canonicalRepositoryPath(context.cwd),
    );
    if (
      cwd !== profile.cwd ||
      context.providerInstanceId !== profile.providerInstanceId ||
      (options.session !== false &&
        profile.providerSessionActive &&
        (context.providerSessionId !== profile.providerSessionId ||
          context.providerGeneration !== profile.goalGeneration)) ||
      context.providerDriver !== profile.providerDriver
    ) {
      return yield* error(
        "external_drift",
        "Thread worktree or provider metadata changed after the experiment was armed.",
      );
    }
    return context;
  });

  const loadIdentity = Effect.fn("ExperimentService.loadIdentity")(function* (
    identity: ExperimentIdentity,
    options: { readonly requireArmed?: boolean } = {},
  ) {
    const stored = Option.getOrUndefined(yield* store.get(identity.threadId));
    if (stored === undefined) return yield* error("authentication_failed", "Experiment not found.");
    if (
      stored.runId !== identity.runId ||
      stored.goalGeneration !== identity.generation ||
      stored.providerInstanceId !== identity.providerInstanceId ||
      stored.providerSessionId !== identity.providerSessionId
    ) {
      return yield* error(
        "authentication_failed",
        "Experiment caller identity does not match the owner.",
      );
    }
    const profile = yield* enforceLimits(stored);
    if (
      options.requireArmed !== false &&
      (!profile.armed || TERMINAL_PHASES.has(profile.phase) || profile.phase === "paused")
    ) {
      return yield* error("invalid_phase", `Experiment is not armed (phase ${profile.phase}).`);
    }
    yield* assertLiveContext(profile);
    return profile;
  });

  const validateRepository = Effect.fn("ExperimentService.validateRepository")(function* (
    profile: ExperimentProfile,
  ) {
    yield* repositoryEffect("validation", async () => {
      await assertConfigDigest(profile.cwd, profile.configDigest);
      await assertRepository(profile.cwd, profile.config, profile.head);
    });
  });

  const remainingMs = Effect.fn("ExperimentService.remainingMs")(function* (
    profile: ExperimentProfile,
    configuredSeconds: number,
  ) {
    const currentMs = yield* Clock.currentTimeMillis;
    const remaining = Date.parse(profile.deadlineAt) - currentMs;
    if (remaining <= 0) return yield* error("limits_exhausted", "Experiment time limit reached.");
    return Math.max(1, Math.min(configuredSeconds * 1_000, remaining));
  });

  const runCommand = Effect.fn("ExperimentService.runCommand")(function* (
    profile: ExperimentProfile,
    argv: ReadonlyArray<string>,
    configuredSeconds: number,
    maxOutputBytes: number,
    options: { readonly signal?: AbortSignal; readonly sync?: boolean } = {},
  ) {
    const timeoutMs = yield* remainingMs(profile, configuredSeconds);
    const result = yield* Effect.tryPromise({
      try: () =>
        processes.run(profile.runId, argv, {
          cwd: profile.cwd,
          timeoutMs,
          maxOutputBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      catch: (cause) => asExperimentError(cause, "Could not run experiment command."),
    });
    const next = yield* save(
      {
        ...profile,
        commandSeconds: profile.commandSeconds + result.durationSeconds,
      },
      { sync: options.sync ?? true },
    );
    yield* validateRepository(next);
    return { result, profile: next };
  });

  const evaluateCommands = Effect.fn("ExperimentService.evaluateCommands")(function* (
    initial: ExperimentProfile,
    options: { readonly sync?: boolean } = {},
  ) {
    let profile = initial;
    const evaluator = yield* runCommand(
      profile,
      profile.config.evaluator.argv,
      profile.config.limits.evaluatorTimeoutSeconds,
      profile.config.limits.maxOutputBytes,
      { sync: options.sync ?? true },
    );
    profile = evaluator.profile;
    if (evaluator.result.termination !== "exit" || evaluator.result.code !== 0) {
      return {
        profile,
        evaluation: {
          passed: false,
          metrics: null,
          metric: null,
          reason: `Evaluator ${evaluator.result.termination} (exit ${String(evaluator.result.code)}).`,
          output: outputTail(evaluator.result),
        } satisfies CommandEvaluation,
      };
    }
    let metrics: Readonly<Record<string, number>>;
    try {
      metrics = parseMetrics(evaluator.result.stdout, profile.config.evaluator.metric);
    } catch (cause) {
      return {
        profile,
        evaluation: {
          passed: false,
          metrics: null,
          metric: null,
          reason: asExperimentError(cause, "Evaluator output was invalid.").message,
          output: outputTail(evaluator.result),
        } satisfies CommandEvaluation,
      };
    }
    for (const [index, argv] of profile.config.checks.entries()) {
      const check = yield* runCommand(
        profile,
        argv,
        profile.config.limits.checkTimeoutSeconds,
        profile.config.limits.maxOutputBytes,
        { sync: options.sync ?? true },
      );
      profile = check.profile;
      if (check.result.termination !== "exit" || check.result.code !== 0) {
        return {
          profile,
          evaluation: {
            passed: false,
            metrics,
            metric: metrics[profile.config.evaluator.metric]!,
            reason: `Check ${index + 1} ${check.result.termination} (exit ${String(check.result.code)}).`,
            output: outputTail(check.result),
          } satisfies CommandEvaluation,
        };
      }
    }
    return {
      profile,
      evaluation: {
        passed: true,
        metrics,
        metric: metrics[profile.config.evaluator.metric]!,
        reason: "Evaluator and checks passed.",
        output: outputTail(evaluator.result),
      } satisfies CommandEvaluation,
    };
  });

  function expectedRecoveryHashes(
    profile: ExperimentProfile,
    pending: PendingExperiment,
    path: string,
  ): ReadonlySet<string> {
    const snapshot = pending.snapshots.find((entry) => entry.path === path);
    if (snapshot === undefined)
      throw error("persistence_failed", `Snapshot is missing for ${path}.`);
    const candidateHash = pending.expectedHashes[path];
    if (candidateHash === undefined) {
      throw error("persistence_failed", `Candidate hash is missing for ${path}.`);
    }
    if (profile.phase === "applying" || profile.phase === "restoring") {
      return new Set([snapshot.hash, candidateHash]);
    }
    return new Set([candidateHash]);
  }

  async function assertSafeRestore(profile: ExperimentProfile): Promise<PendingExperiment> {
    const pending = profile.pending;
    if (pending === null) throw error("persistence_failed", "Rollback metadata is missing.");
    const [head, staged, actualChanged] = await Promise.all([
      currentHead(profile.cwd),
      stagedPaths(profile.cwd),
      changedPaths(profile.cwd),
    ]);
    if (head !== pending.headBefore || staged.length > 0) {
      throw error("external_drift", "HEAD or index changed; rollback was not attempted.");
    }
    const expectedPaths = pending.snapshots.map((entry) => entry.path);
    if (!actualChanged.every((entry) => expectedPaths.includes(entry))) {
      throw error(
        "external_drift",
        "Unowned worktree changes were found; rollback was not attempted.",
      );
    }
    const hashes = await Promise.all(
      pending.snapshots.map((snapshot) => fileHash(profile.cwd, snapshot.path)),
    );
    for (const [index, snapshot] of pending.snapshots.entries()) {
      if (!expectedRecoveryHashes(profile, pending, snapshot.path).has(hashes[index]!)) {
        throw error(
          "external_drift",
          `Owned file ${snapshot.path} changed unexpectedly; rollback was not attempted.`,
        );
      }
    }
    return pending;
  }

  function restore(
    initial: ExperimentProfile,
    evaluation: CommandEvaluation | null,
    reason: string,
  ) {
    return Effect.gen(function* () {
      const pending = yield* repositoryEffect("restore validation", () =>
        assertSafeRestore(initial),
      );
      let profile = yield* save({ ...initial, phase: "restoring", armed: false });
      for (const snapshot of pending.snapshots) {
        if (!pending.restoredPaths.includes(snapshot.path)) {
          const currentPending = profile.pending ?? pending;
          const currentHash = yield* repositoryEffect(`inspect ${snapshot.path}`, () =>
            fileHash(profile.cwd, snapshot.path),
          );
          const acceptable = expectedRecoveryHashes(profile, currentPending, snapshot.path);
          if (!acceptable.has(currentHash)) {
            return yield* error(
              "external_drift",
              `Owned file ${snapshot.path} changed before it could be restored.`,
            );
          }
          if (currentHash !== snapshot.hash) {
            yield* repositoryEffect(`restore ${snapshot.path}`, () =>
              restoreSnapshot(profile.cwd, snapshot, currentHash),
            );
          }
          profile = yield* save({
            ...profile,
            pending: {
              ...pending,
              restoredPaths: [...(profile.pending?.restoredPaths ?? []), snapshot.path],
            },
          });
        }
      }
      yield* repositoryEffect("post-restore validation", () => assertClean(profile.cwd));
      const currentMs = yield* Clock.currentTimeMillis;
      const exhausted =
        initial.experimentsRun + 1 >= initial.config.limits.maxExperiments ||
        currentMs >= Date.parse(initial.deadlineAt);
      if (exhausted && profile.providerSessionActive) {
        yield* coordinator.stopProvider({ threadId: profile.threadId, runId: profile.runId });
        profile = { ...profile, providerSessionActive: false };
      }
      profile = yield* save({
        ...profile,
        phase: exhausted ? "exhausted" : "ready",
        armed: !exhausted,
        providerSessionActive: exhausted ? false : profile.providerSessionActive,
        experimentsRun: initial.experimentsRun + 1,
        experimentsRestored: initial.experimentsRestored + 1,
        lastMetric: evaluation?.metric ?? null,
        pending: null,
        lastError: exhausted ? "Experiment limits reached." : null,
      });
      yield* ledger(profile, {
        type: "evaluation",
        outcome: "restored",
        hypothesis: pending.hypothesis,
        metric: evaluation?.metric ?? null,
        metrics: evaluation?.metrics ?? null,
        reason,
      });
      if (exhausted) {
        yield* coordinator.holdGoal({
          threadId: profile.threadId,
          action: "pause",
          reason: "Experiment limits reached.",
        });
      }
      return profile;
    });
  }

  const failClosed = Effect.fn("ExperimentService.failClosed")(function* (
    profile: ExperimentProfile,
    cause: unknown,
  ) {
    const failure = asExperimentError(cause, "Experiment failed closed.");
    if (profile.providerSessionActive) {
      yield* coordinator
        .stopProvider({ threadId: profile.threadId, runId: profile.runId })
        .pipe(Effect.ignore);
    }
    const next = yield* save(
      {
        ...profile,
        phase: "failed",
        armed: false,
        providerSessionActive: false,
        lastError: failure.message.slice(0, 2_000),
      },
      { sync: profile.providerSessionActive },
    );
    yield* ledger(next, { type: "failure", reason: next.lastError }).pipe(Effect.ignore);
    yield* coordinator
      .holdGoal({ threadId: next.threadId, action: "block", reason: failure.message })
      .pipe(Effect.ignore);
    return failure;
  });

  const preview = Effect.fn("ExperimentService.preview")(function* (input: {
    readonly threadId: string;
    readonly objective: string;
  }) {
    let objective: string;
    try {
      objective = decodeObjective(input.objective);
    } catch (cause) {
      return yield* error(
        "invalid_config",
        "Objective must be 1 to 1024 trimmed characters.",
        cause,
      );
    }
    const context = yield* coordinator.resolveThread(input.threadId);
    if (!context.idle || context.pendingChildRun) {
      return yield* error("thread_busy", "Thread must be idle with no pending child run.");
    }
    const cwd = yield* repositoryEffect("canonicalize repository", async () =>
      canonicalRepositoryPath(context.cwd),
    );
    const { config, digest } = yield* repositoryEffect("config preview", () => readConfig(cwd));
    yield* repositoryEffect("preview validation", async () => {
      await assertRepository(cwd, config);
      await assertClean(cwd);
    });
    const existing = yield* store.list();
    if (
      existing.some(
        (profile) => repositoryPathsEqual(profile.cwd, cwd) && !TERMINAL_PHASES.has(profile.phase),
      )
    ) {
      return yield* error("invalid_phase", "Another experiment already owns this worktree.");
    }
    const currentMs = yield* Clock.currentTimeMillis;
    const confirmationId = randomUUID();
    const expiresAt = nowIso(currentMs + CONFIRMATION_TTL_MS);
    const head = yield* repositoryEffect("read HEAD", () => currentHead(cwd));
    confirmations.set(confirmationId, {
      threadId: input.threadId,
      objective,
      confirmationId,
      expiresAt,
      cwd,
      branch: config.branch,
      head,
      configDigest: digest,
      config,
      providerInstanceId: context.providerInstanceId,
      providerSessionId: context.providerSessionId,
      providerDriver: context.providerDriver,
    });
    return {
      objective,
      confirmationId,
      expiresAt,
      cwd,
      branch: config.branch,
      head,
      configDigest: digest,
      approvedFiles: config.files,
      provider: {
        instanceId: ProviderInstanceId.make(context.providerInstanceId),
        driver: ProviderDriverKind.make(context.providerDriver),
        supported: context.providerSupported,
        reason: context.providerSupported
          ? null
          : (context.unsupportedReason ?? "Provider does not support isolated experiment tools."),
      },
      evaluator: {
        argv: config.evaluator.argv,
        metric: {
          name: config.evaluator.metric,
          direction: config.evaluator.direction === "higher" ? "maximize" : "minimize",
          minimumImprovement: config.evaluator.minimumImprovement,
        },
      },
      checks: config.checks.map((argv, index) => ({ name: `Check ${index + 1}`, argv })),
      limits: {
        maxExperiments: config.limits.maxExperiments,
        maxTotalSeconds: config.limits.maxTotalSeconds,
        evaluatorTimeoutSeconds: config.limits.evaluatorTimeoutSeconds,
        checkTimeoutSeconds: config.limits.checkTimeoutSeconds,
        maxEvaluatorOutputBytes: config.limits.maxOutputBytes,
        maxCheckOutputBytes: config.limits.maxOutputBytes,
        maxFilesPerApply: Math.min(100, config.files.length),
        maxBytesPerFile: config.limits.maxApplyBytes,
        maxTotalApplyBytes: config.limits.maxApplyBytes,
      },
    } satisfies ThreadExperimentPreview;
  });

  const startUnlocked = Effect.fn("ExperimentService.startUnlocked")(function* (input: {
    readonly threadId: string;
    readonly objective: string;
    readonly confirmationId: string;
  }) {
    const confirmation = confirmations.get(input.confirmationId);
    confirmations.delete(input.confirmationId);
    const currentMs = yield* Clock.currentTimeMillis;
    if (confirmation === undefined || currentMs >= Date.parse(confirmation.expiresAt)) {
      return yield* error(
        "confirmation_invalid",
        "Experiment confirmation expired or was already consumed.",
      );
    }
    if (confirmation.threadId !== input.threadId || confirmation.objective !== input.objective) {
      return yield* error(
        "confirmation_invalid",
        "Experiment confirmation does not match this request.",
      );
    }
    const context = yield* coordinator.resolveThread(input.threadId);
    if (!context.providerSupported) {
      return yield* error(
        "unsupported_provider",
        context.unsupportedReason ?? "Provider does not support isolated experiment tools.",
      );
    }
    if (!context.idle || context.pendingChildRun) {
      return yield* error("thread_busy", "Thread became busy after confirmation.");
    }
    const currentCwd = yield* repositoryEffect("canonicalize repository", async () =>
      canonicalRepositoryPath(context.cwd),
    );
    if (
      currentCwd !== confirmation.cwd ||
      context.providerInstanceId !== confirmation.providerInstanceId ||
      context.providerSessionId !== confirmation.providerSessionId ||
      context.providerDriver !== confirmation.providerDriver
    ) {
      return yield* error(
        "confirmation_invalid",
        "Thread provider or worktree changed after confirmation.",
      );
    }
    yield* repositoryEffect("start revalidation", async () => {
      await assertConfigDigest(confirmation.cwd, confirmation.configDigest);
      await assertRepository(confirmation.cwd, confirmation.config, confirmation.head);
      await assertClean(confirmation.cwd);
    });
    const all = yield* store.list();
    if (
      all.some(
        (profile) =>
          repositoryPathsEqual(profile.cwd, confirmation.cwd) &&
          !TERMINAL_PHASES.has(profile.phase),
      )
    ) {
      return yield* error("invalid_phase", "Another experiment already owns this worktree.");
    }
    const previous = Option.getOrUndefined(yield* store.get(input.threadId));
    const createdAt = nowIso(currentMs);
    let profile: ExperimentProfile = {
      version: 1,
      runId: randomUUID(),
      threadId: input.threadId,
      goalGeneration: (previous?.goalGeneration ?? 0) + 1,
      objective: input.objective,
      phase: "baseline",
      armed: false,
      cwd: confirmation.cwd,
      branch: confirmation.branch,
      head: confirmation.head,
      providerInstanceId: confirmation.providerInstanceId,
      providerSessionId: confirmation.providerSessionId,
      providerDriver: confirmation.providerDriver,
      providerSessionActive: false,
      config: confirmation.config,
      configDigest: confirmation.configDigest,
      baselineMetric: null,
      bestMetric: null,
      lastMetric: null,
      experimentsRun: 0,
      experimentsKept: 0,
      experimentsRestored: 0,
      commandSeconds: 0,
      createdAt,
      deadlineAt: nowIso(currentMs + confirmation.config.limits.maxTotalSeconds * 1_000),
      updatedAt: createdAt,
      pending: null,
      lastError: null,
    };
    profile = yield* save(profile, { sync: false });
    yield* ledger(profile, {
      type: "started",
      objective: profile.objective,
      branch: profile.branch,
      head: profile.head,
      configDigest: profile.configDigest,
    });
    const evaluated = yield* evaluateCommands(profile, { sync: false }).pipe(
      Effect.catch((cause) =>
        failClosed(profile, cause).pipe(Effect.flatMap((failure) => Effect.fail(failure))),
      ),
    );
    profile = evaluated.profile;
    yield* repositoryEffect("baseline clean-tree validation", () => assertClean(profile.cwd)).pipe(
      Effect.catch((cause) =>
        failClosed(profile, cause).pipe(Effect.flatMap((failure) => Effect.fail(failure))),
      ),
    );
    if (!evaluated.evaluation.passed || evaluated.evaluation.metric === null) {
      const failure = error("evaluation_failed", `Baseline failed: ${evaluated.evaluation.reason}`);
      return yield* failClosed(profile, failure).pipe(
        Effect.flatMap((failed) => Effect.fail(failed)),
      );
    }
    profile = yield* save(
      {
        ...profile,
        phase: "ready",
        armed: false,
        baselineMetric: evaluated.evaluation.metric,
        bestMetric: evaluated.evaluation.metric,
        lastMetric: evaluated.evaluation.metric,
      },
      { sync: false },
    );
    yield* ledger(profile, {
      type: "baseline",
      outcome: "established",
      metric: evaluated.evaluation.metric,
      metrics: evaluated.evaluation.metrics,
    });
    const started = yield* coordinator
      .startProvider({
        threadId: profile.threadId,
        providerInstanceId: profile.providerInstanceId,
        cwd: profile.cwd,
        runId: profile.runId,
        generation: profile.goalGeneration,
      })
      .pipe(
        Effect.catch((cause) =>
          failClosed(profile, cause).pipe(Effect.flatMap((failure) => Effect.fail(failure))),
        ),
      );
    if (
      started.threadId !== profile.threadId ||
      started.providerInstanceId !== profile.providerInstanceId ||
      started.runId !== profile.runId ||
      started.generation !== profile.goalGeneration
    ) {
      yield* coordinator.stopProvider({ threadId: profile.threadId, runId: profile.runId });
      const failure = error(
        "authentication_failed",
        "Restricted provider returned a mismatched experiment identity.",
      );
      return yield* failClosed(profile, failure).pipe(
        Effect.flatMap((closed) => Effect.fail(closed)),
      );
    }
    profile = yield* save(
      {
        ...profile,
        providerSessionId: started.providerSessionId,
        providerSessionActive: true,
        armed: true,
      },
      { sync: false },
    ).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* coordinator
            .stopProvider({ threadId: profile.threadId, runId: profile.runId })
            .pipe(Effect.ignore);
          return yield* failClosed(profile, cause).pipe(
            Effect.flatMap((closed) => Effect.fail(closed)),
          );
        }),
      ),
    );
    const summary = publicSummary(profile, yield* Clock.currentTimeMillis);
    yield* coordinator
      .activateGoal({
        threadId: profile.threadId,
        objective: profile.objective,
        summary,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* coordinator
              .stopProvider({ threadId: profile.threadId, runId: profile.runId })
              .pipe(Effect.ignore);
            const failure = asExperimentError(cause, "Could not activate the experiment goal.");
            profile = yield* save(
              {
                ...profile,
                phase: "failed",
                armed: false,
                providerSessionActive: false,
                lastError: failure.message.slice(0, 2_000),
              },
              { sync: false },
            );
            yield* ledger(profile, { type: "failure", reason: profile.lastError }).pipe(
              Effect.ignore,
            );
            yield* coordinator
              .holdGoal({ threadId: profile.threadId, action: "block", reason: failure.message })
              .pipe(Effect.ignore);
            return yield* failure;
          }),
        ),
      );
    return summary;
  });

  const start = (input: {
    readonly threadId: string;
    readonly objective: string;
    readonly confirmationId: string;
  }) => startLock.withPermits(1)(withThreadLock(input.threadId, startUnlocked(input)));

  const refreshForRead = Effect.fn("ExperimentService.refreshForRead")(function* (
    stored: ExperimentProfile,
  ) {
    const profile = yield* enforceLimits(stored);
    if (!profile.armed || !profile.providerSessionActive || TERMINAL_PHASES.has(profile.phase)) {
      return profile;
    }
    return yield* assertLiveContext(profile).pipe(
      Effect.as(profile),
      Effect.catch((cause) =>
        failClosed(profile, cause).pipe(
          Effect.flatMap(() => store.get(profile.threadId)),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(error("persistence_failed", "Experiment disappeared.")),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
    );
  });

  const getUnlocked = Effect.fn("ExperimentService.getUnlocked")(function* (input: {
    readonly threadId: string;
  }) {
    const stored = Option.getOrUndefined(yield* store.get(input.threadId));
    if (stored === undefined) return null;
    const profile = yield* refreshForRead(stored);
    return publicSummary(profile, yield* Clock.currentTimeMillis);
  });
  const get = (input: { readonly threadId: string }) =>
    withThreadLock(input.threadId, getUnlocked(input));

  const statusUnlocked = Effect.fn("ExperimentService.statusUnlocked")(function* (
    identity: ExperimentIdentity,
  ) {
    const stored = Option.getOrUndefined(yield* store.get(identity.threadId));
    if (stored === undefined) return yield* error("authentication_failed", "Experiment not found.");
    if (
      stored.runId !== identity.runId ||
      stored.goalGeneration !== identity.generation ||
      stored.providerInstanceId !== identity.providerInstanceId ||
      stored.providerSessionId !== identity.providerSessionId
    ) {
      return yield* error(
        "authentication_failed",
        "Experiment caller identity does not match the owner.",
      );
    }
    const profile = yield* refreshForRead(stored);
    return toolSummary(profile);
  });
  const status = (identity: ExperimentIdentity) =>
    withThreadLock(identity.threadId, statusUnlocked(identity));

  const listFilesUnlocked = Effect.fn("ExperimentService.listFilesUnlocked")(function* (
    identity: ExperimentIdentity,
  ) {
    const profile = yield* loadIdentity(identity, { requireArmed: false });
    yield* validateRepository(profile);
    return { files: profile.config.files };
  });
  const listFiles = (identity: ExperimentIdentity) =>
    withThreadLock(identity.threadId, listFilesUnlocked(identity));

  const readFileUnlocked = Effect.fn("ExperimentService.readFileUnlocked")(function* (
    input: ExperimentIdentity & { readonly path: string },
  ) {
    const profile = yield* loadIdentity(input, { requireArmed: false });
    yield* validateRepository(profile);
    const normalized = normalizeApprovedPath(input.path);
    if (!profile.config.files.includes(normalized)) {
      return yield* error("authentication_failed", "File is not approved for this experiment.");
    }
    const content = yield* repositoryEffect("read approved file", () =>
      readApprovedFile(profile.cwd, normalized, profile.config.limits.maxApplyBytes),
    );
    return { path: normalized, content };
  });
  const readFile = (input: ExperimentIdentity & { readonly path: string }) =>
    withThreadLock(input.threadId, readFileUnlocked(input));

  const applyUnlocked = Effect.fn("ExperimentService.applyUnlocked")(function* (
    input: ExperimentIdentity & {
      readonly hypothesis: string;
      readonly changes: ReadonlyArray<ExperimentChange>;
    },
  ) {
    let profile = yield* loadIdentity(input);
    if (profile.phase !== "ready" || profile.pending !== null || profile.baselineMetric === null) {
      return yield* error(
        "invalid_phase",
        "A baseline is required and no candidate may already be pending.",
      );
    }
    yield* validateRepository(profile);
    yield* repositoryEffect("pre-apply clean-tree validation", () => assertClean(profile.cwd));
    let hypothesis: string;
    try {
      hypothesis = decodeHypothesis(input.hypothesis);
    } catch (cause) {
      return yield* error(
        "invalid_config",
        "Hypothesis must be 1 to 500 trimmed characters.",
        cause,
      );
    }
    const maxFiles = Math.min(100, profile.config.files.length);
    if (input.changes.length === 0 || input.changes.length > maxFiles) {
      return yield* error("invalid_config", `Apply must contain 1 to ${maxFiles} files.`);
    }
    const seen = new Set<string>();
    let totalBytes = 0;
    const changes: Array<ExperimentChange> = [];
    for (const change of input.changes) {
      let relativePath: string;
      try {
        relativePath = normalizeApprovedPath(change.path);
        resolveApprovedFile(profile.cwd, relativePath);
      } catch (cause) {
        return yield* asExperimentError(cause, "Candidate path is unsafe.");
      }
      if (!profile.config.files.includes(relativePath)) {
        return yield* error("authentication_failed", `Path is not approved: ${relativePath}.`);
      }
      if (seen.has(relativePath)) {
        return yield* error("invalid_config", `Duplicate change path: ${relativePath}.`);
      }
      seen.add(relativePath);
      const bytes = Buffer.byteLength(change.content, "utf8");
      if (bytes > profile.config.limits.maxApplyBytes) {
        return yield* error(
          "invalid_config",
          `Candidate file ${relativePath} exceeds the apply-size limit.`,
        );
      }
      totalBytes += bytes;
      changes.push({ path: relativePath, content: change.content });
    }
    if (totalBytes > profile.config.limits.maxApplyBytes) {
      return yield* error("invalid_config", "Candidate exceeds the total apply-size limit.");
    }
    const paths = changes.map((change) => change.path);
    const snapshots = yield* repositoryEffect("snapshot", () => snapshotFiles(profile.cwd, paths));
    const hashes = yield* repositoryEffect("candidate hashing", () =>
      Promise.all(changes.map((change) => hashContent(profile.cwd, change.content))),
    );
    const expectedHashes = Object.fromEntries(
      changes.map((change, index) => [change.path, hashes[index]!] as const),
    );
    const pending: PendingExperiment = {
      id: randomUUID(),
      hypothesis,
      headBefore: profile.head,
      snapshots,
      expectedHashes,
      writtenPaths: [],
      restoredPaths: [],
      metric: null,
      metrics: null,
    };
    profile = yield* save({ ...profile, phase: "applying", armed: false, pending });
    return yield* Effect.gen(function* () {
      for (const change of changes) {
        const snapshot = pending.snapshots.find((entry) => entry.path === change.path)!;
        yield* repositoryEffect(`write ${change.path}`, () =>
          writeFileAtomically(
            resolveApprovedFile(profile.cwd, change.path),
            Buffer.from(change.content, "utf8"),
            snapshot.mode,
            () => assertFileMatches(profile.cwd, change.path, snapshot.hash, snapshot.mode),
          ),
        );
        profile = yield* save({
          ...profile,
          pending: {
            ...pending,
            writtenPaths: [...(profile.pending?.writtenPaths ?? []), change.path],
          },
        });
      }
      const [actual, staged] = yield* repositoryEffect("post-apply status", () =>
        Promise.all([changedPaths(profile.cwd), stagedPaths(profile.cwd)]),
      );
      if (actual.length === 0 || !setEquals(actual, paths) || staged.length > 0) {
        throw error(
          "external_drift",
          "Candidate must change exactly the requested approved paths.",
        );
      }
      const actualHashes = yield* repositoryEffect("post-apply hashes", () =>
        Promise.all(changes.map((change) => fileHash(profile.cwd, change.path))),
      );
      for (const [index, change] of changes.entries()) {
        if (actualHashes[index] !== expectedHashes[change.path]) {
          throw error(
            "external_drift",
            `Candidate content for ${change.path} did not match the applied payload.`,
          );
        }
      }
      profile = yield* save({ ...profile, phase: "applied", armed: true });
      yield* ledger(profile, {
        type: "applied",
        candidate: pending.id,
        hypothesis,
        files: paths,
      });
      return { candidateId: pending.id, files: paths };
    }).pipe(
      Effect.catch((cause) =>
        restore(profile, null, "Applying the candidate failed.").pipe(
          Effect.flatMap(() =>
            Effect.fail(asExperimentError(cause, "Applying the candidate failed.")),
          ),
          Effect.catch((restoreCause) =>
            failClosed(profile, restoreCause).pipe(
              Effect.flatMap((failure) => Effect.fail(failure)),
            ),
          ),
        ),
      ),
    );
  });

  const apply = (
    input: ExperimentIdentity & {
      readonly hypothesis: string;
      readonly changes: ReadonlyArray<ExperimentChange>;
    },
  ) => withThreadLock(input.threadId, applyUnlocked(input));

  const evaluateUnlocked = Effect.fn("ExperimentService.evaluateUnlocked")(function* (
    identity: ExperimentIdentity,
  ) {
    let profile = yield* loadIdentity(identity);
    const baseline = profile.phase === "baseline" && profile.pending === null;
    const candidate = profile.phase === "applied" && profile.pending !== null;
    if (!baseline && !candidate) {
      return yield* error("invalid_phase", "No candidate is ready for evaluation.");
    }
    yield* Effect.gen(function* () {
      yield* validateRepository(profile);
      if (candidate) {
        yield* repositoryEffect("candidate validation", () => assertSafeRestore(profile));
      } else {
        yield* repositoryEffect("baseline validation", () => assertClean(profile.cwd));
      }
    }).pipe(
      Effect.catch((cause) =>
        failClosed(profile, cause).pipe(Effect.flatMap((failure) => Effect.fail(failure))),
      ),
    );
    profile = yield* save({ ...profile, phase: "evaluating", armed: false });
    const execution = yield* Effect.gen(function* () {
      const evaluated = yield* evaluateCommands(profile);
      profile = evaluated.profile;
      if (candidate) {
        yield* repositoryEffect("post-evaluation candidate validation", () =>
          assertSafeRestore(profile),
        );
      } else {
        yield* repositoryEffect("post-evaluation baseline validation", () =>
          assertClean(profile.cwd),
        );
      }
      return { _tag: "evaluated" as const, evaluated };
    }).pipe(
      Effect.catch((cause) => {
        if (candidate && profile.pending !== null) {
          return restore(profile, null, "Evaluation crashed or repository validation failed.").pipe(
            Effect.map(
              () =>
                ({
                  _tag: "result" as const,
                  result: {
                    outcome: "restored",
                    metric: null,
                    metrics: {},
                    commit: null,
                    reason: asExperimentError(cause, "Evaluation failed; candidate restored.")
                      .message,
                  } satisfies ExperimentEvaluationResult,
                }) as const,
            ),
            Effect.catch((restoreCause) =>
              failClosed(profile, restoreCause).pipe(
                Effect.flatMap((failure) => Effect.fail(failure)),
              ),
            ),
          );
        }
        return failClosed(profile, cause).pipe(Effect.flatMap((failure) => Effect.fail(failure)));
      }),
    );
    if (execution._tag === "result") return execution.result;
    const evaluated = execution.evaluated;
    if (baseline) {
      if (!evaluated.evaluation.passed || evaluated.evaluation.metric === null) {
        const failure = yield* failClosed(
          profile,
          error("evaluation_failed", `Baseline failed: ${evaluated.evaluation.reason}`),
        );
        return yield* failure;
      }
      profile = yield* save({
        ...profile,
        phase: "ready",
        armed: true,
        baselineMetric: evaluated.evaluation.metric,
        bestMetric: evaluated.evaluation.metric,
        lastMetric: evaluated.evaluation.metric,
      });
      yield* ledger(profile, {
        type: "baseline",
        outcome: "established",
        metric: evaluated.evaluation.metric,
        metrics: evaluated.evaluation.metrics ?? {},
      });
      return {
        outcome: "baseline",
        metric: evaluated.evaluation.metric,
        metrics: evaluated.evaluation.metrics ?? {},
        commit: null,
        reason: evaluated.evaluation.reason,
      } satisfies ExperimentEvaluationResult;
    }
    const pending = profile.pending!;
    if (
      !evaluated.evaluation.passed ||
      evaluated.evaluation.metric === null ||
      profile.bestMetric === null ||
      !qualifies(profile.config, evaluated.evaluation.metric, profile.bestMetric)
    ) {
      const reason = !evaluated.evaluation.passed
        ? evaluated.evaluation.reason
        : "Candidate did not meet the strict minimum improvement.";
      profile = yield* restore(profile, evaluated.evaluation, reason);
      return {
        outcome: "restored",
        metric: evaluated.evaluation.metric,
        metrics: evaluated.evaluation.metrics ?? {},
        commit: null,
        reason,
      } satisfies ExperimentEvaluationResult;
    }
    profile = yield* save({
      ...profile,
      phase: "committing",
      armed: false,
      pending: {
        ...pending,
        metric: evaluated.evaluation.metric,
        metrics: evaluated.evaluation.metrics,
      },
    });
    const candidateFiles = pending.snapshots.map((entry) => entry.path);
    const commitAttempt = yield* repositoryEffect("commit", () =>
      commitCandidate(
        profile.cwd,
        candidateFiles,
        pending.hypothesis,
        profile.config.evaluator.metric,
        evaluated.evaluation.metric!,
      ),
    ).pipe(Effect.result);
    if (Result.isFailure(commitAttempt)) {
      const failure = asExperimentError(commitAttempt.failure, "Experiment commit failed.");
      yield* repositoryEffect("unstage rejected candidate", () =>
        unstageCandidate(profile.cwd, candidateFiles),
      ).pipe(
        Effect.catch((cause) =>
          failClosed(profile, cause).pipe(Effect.flatMap((closed) => Effect.fail(closed))),
        ),
      );
      profile = yield* restore(profile, evaluated.evaluation, failure.message).pipe(
        Effect.catch((cause) =>
          failClosed(profile, cause).pipe(Effect.flatMap((closed) => Effect.fail(closed))),
        ),
      );
      return {
        outcome: "restored",
        metric: evaluated.evaluation.metric,
        metrics: evaluated.evaluation.metrics ?? {},
        commit: null,
        reason: failure.message,
      } satisfies ExperimentEvaluationResult;
    }
    const commit = commitAttempt.success;
    yield* Effect.gen(function* () {
      const [parentResult, committedResult, changed, staged] = yield* repositoryEffect(
        "commit verification",
        () =>
          Promise.all([
            git(profile.cwd, ["rev-parse", "HEAD^"]),
            git(profile.cwd, ["diff", "--name-only", "-z", "HEAD^", "HEAD", "--"]),
            changedPaths(profile.cwd),
            stagedPaths(profile.cwd),
          ]),
      );
      const parent = parentResult.stdout.trim();
      const committedPaths = committedResult.stdout.split("\0").filter(Boolean);
      if (
        parent !== pending.headBefore ||
        !setEquals(
          committedPaths,
          pending.snapshots.map((entry) => entry.path),
        ) ||
        changed.length > 0 ||
        staged.length > 0
      ) {
        throw error(
          "external_drift",
          "Experiment commit did not produce the exact clean child commit.",
        );
      }
      yield* repositoryEffect("post-commit config validation", () =>
        assertConfigDigest(profile.cwd, profile.configDigest),
      );
    }).pipe(
      Effect.catch((cause) =>
        failClosed(profile, cause).pipe(Effect.flatMap((failure) => Effect.fail(failure))),
      ),
    );
    const currentMs = yield* Clock.currentTimeMillis;
    const runCount = profile.experimentsRun + 1;
    const exhausted =
      runCount >= profile.config.limits.maxExperiments ||
      currentMs >= Date.parse(profile.deadlineAt);
    if (exhausted && profile.providerSessionActive) {
      yield* coordinator.stopProvider({ threadId: profile.threadId, runId: profile.runId });
      profile = { ...profile, providerSessionActive: false };
    }
    profile = yield* save({
      ...profile,
      head: commit,
      phase: exhausted ? "exhausted" : "ready",
      armed: !exhausted,
      providerSessionActive: exhausted ? false : profile.providerSessionActive,
      bestMetric: evaluated.evaluation.metric,
      lastMetric: evaluated.evaluation.metric,
      experimentsRun: runCount,
      experimentsKept: profile.experimentsKept + 1,
      pending: null,
      lastError: exhausted ? "Experiment limits reached." : null,
    });
    yield* ledger(profile, {
      type: "evaluation",
      outcome: "kept",
      hypothesis: pending.hypothesis,
      metric: evaluated.evaluation.metric,
      metrics: evaluated.evaluation.metrics ?? {},
      commit,
    });
    if (exhausted) {
      yield* coordinator.holdGoal({
        threadId: profile.threadId,
        action: "pause",
        reason: "Experiment limits reached.",
      });
    }
    return {
      outcome: "kept",
      metric: evaluated.evaluation.metric,
      metrics: evaluated.evaluation.metrics,
      commit,
      reason: evaluated.evaluation.reason,
    } satisfies ExperimentEvaluationResult;
  });

  const evaluate = (identity: ExperimentIdentity) =>
    withThreadLock(identity.threadId, evaluateUnlocked(identity));

  const recoverOne = Effect.fn("ExperimentService.recoverOne")(function* (
    initial: ExperimentProfile,
  ) {
    if (!RECOVERY_PHASES.has(initial.phase) || initial.pending === null) {
      if (
        initial.phase === "baseline" ||
        initial.phase === "ready" ||
        (initial.phase === "paused" && initial.providerSessionActive)
      ) {
        const recovered = yield* save(
          {
            ...initial,
            phase: initial.phase === "baseline" ? "failed" : "paused",
            armed: false,
            providerSessionActive: false,
            lastError:
              initial.phase === "baseline"
                ? "Server restarted before the baseline completed."
                : "Server restarted; resume to start a fresh restricted provider session.",
          },
          { sync: initial.phase !== "baseline" },
        );
        yield* ledger(recovered, { type: "recovery", outcome: recovered.phase });
      }
      return;
    }
    let profile = initial;
    yield* Effect.gen(function* () {
      yield* assertLiveContext(profile, { session: false });
      yield* repositoryEffect("recovery config validation", () =>
        assertConfigDigest(profile.cwd, profile.configDigest),
      );
      const pending = profile.pending;
      if (pending === null) return;
      const head = yield* repositoryEffect("recovery HEAD", () => currentHead(profile.cwd));
      if (profile.phase === "committing" && head !== pending.headBefore) {
        const [parentResult, filesResult, changed, staged] = yield* repositoryEffect(
          "commit recovery validation",
          () =>
            Promise.all([
              git(profile.cwd, ["rev-parse", "HEAD^"]),
              git(profile.cwd, ["diff", "--name-only", "-z", "HEAD^", "HEAD", "--"]),
              changedPaths(profile.cwd),
              stagedPaths(profile.cwd),
            ]),
        );
        const parent = parentResult.stdout.trim();
        const files = filesResult.stdout.split("\0").filter(Boolean);
        if (
          parent === pending.headBefore &&
          pending.metric !== null &&
          setEquals(
            files,
            pending.snapshots.map((entry) => entry.path),
          ) &&
          changed.length === 0 &&
          staged.length === 0
        ) {
          profile = yield* save({
            ...profile,
            head,
            phase: "paused",
            armed: false,
            providerSessionActive: false,
            bestMetric: pending.metric,
            lastMetric: pending.metric,
            experimentsRun: profile.experimentsRun + 1,
            experimentsKept: profile.experimentsKept + 1,
            pending: null,
          });
          yield* ledger(profile, { type: "recovery", outcome: "commit_recovered" });
          return;
        }
      }
      profile = yield* restore(profile, null, `Recovered interrupted ${profile.phase} phase.`);
      profile = yield* save({
        ...profile,
        phase: "paused",
        armed: false,
        providerSessionActive: false,
        lastError: "Recovered an interrupted candidate; resume to start a fresh provider session.",
      });
      yield* ledger(profile, { type: "recovery", outcome: "candidate_restored" });
    }).pipe(Effect.catch((cause) => failClosed(profile, cause).pipe(Effect.asVoid)));
  });

  const settleUnlocked = Effect.fn("ExperimentService.settleUnlocked")(function* (input: {
    readonly threadId: string;
    readonly reason: string;
    readonly terminal: "pause" | "block" | "complete" | "clear" | "capped";
  }) {
    const stored = Option.getOrUndefined(yield* store.get(input.threadId));
    if (stored === undefined || TERMINAL_PHASES.has(stored.phase)) return;
    let profile = stored;
    profile = yield* save({ ...profile, providerSessionActive: false, armed: false });
    if (profile.pending !== null) {
      const restored = yield* restore(profile, null, input.reason).pipe(
        Effect.map(Option.some),
        Effect.catch((cause) => failClosed(profile, cause).pipe(Effect.as(Option.none()))),
      );
      if (Option.isNone(restored)) return;
      profile = restored.value;
    }
    const nextPhase: ExperimentPhase =
      input.terminal === "complete" || input.terminal === "clear"
        ? "completed"
        : input.terminal === "capped" || input.terminal === "pause"
          ? "paused"
          : "failed";
    profile = yield* save({
      ...profile,
      phase: nextPhase,
      armed: false,
      lastError: nextPhase === "completed" ? null : input.reason.slice(0, 2_000),
    });
    yield* ledger(profile, { type: "settled", phase: nextPhase, reason: input.reason });
  });

  const settle = (input: {
    readonly threadId: string;
    readonly reason: string;
    readonly terminal: "pause" | "block" | "complete" | "clear" | "capped";
  }) =>
    Effect.gen(function* () {
      const before = Option.getOrUndefined(yield* store.get(input.threadId));
      if (before !== undefined) {
        yield* Effect.tryPromise({
          try: () => processes.cancel(before.runId),
          catch: (cause) => asExperimentError(cause, "Could not stop experiment processes."),
        });
        if (before.providerSessionActive) {
          yield* coordinator.stopProvider({ threadId: before.threadId, runId: before.runId });
        }
      }
      yield* withThreadLock(input.threadId, settleUnlocked(input));
    });

  const resumeUnlocked = Effect.fn("ExperimentService.resumeUnlocked")(function* (
    threadId: string,
  ) {
    let profile = Option.getOrUndefined(yield* store.get(threadId));
    if (profile === undefined)
      return yield* error("authentication_failed", "Experiment not found.");
    profile = yield* enforceLimits(profile);
    if (profile.phase === "ready" && profile.armed && profile.providerSessionActive) {
      return publicSummary(profile, yield* Clock.currentTimeMillis);
    }
    if (profile.phase !== "paused" || profile.pending !== null) {
      return yield* error("invalid_phase", `Experiment cannot resume from phase ${profile.phase}.`);
    }
    yield* assertLiveContext(profile);
    yield* validateRepository(profile);
    const cwd = profile.cwd;
    yield* repositoryEffect("resume clean-tree validation", () => assertClean(cwd));
    const generation = profile.goalGeneration + 1;
    const started = yield* coordinator.startProvider({
      threadId: profile.threadId,
      providerInstanceId: profile.providerInstanceId,
      cwd: profile.cwd,
      runId: profile.runId,
      generation,
    });
    if (
      started.threadId !== profile.threadId ||
      started.providerInstanceId !== profile.providerInstanceId ||
      started.runId !== profile.runId ||
      started.generation !== generation
    ) {
      yield* coordinator.stopProvider({ threadId: profile.threadId, runId: profile.runId });
      return yield* error(
        "authentication_failed",
        "Restricted provider returned a mismatched experiment identity.",
      );
    }
    profile = yield* save({
      ...profile,
      goalGeneration: generation,
      phase: "ready",
      armed: true,
      providerSessionActive: true,
      providerSessionId: started.providerSessionId,
      lastError: null,
    });
    yield* ledger(profile, { type: "resumed" });
    return publicSummary(profile, yield* Clock.currentTimeMillis);
  });

  const resume = (threadId: string) => withThreadLock(threadId, resumeUnlocked(threadId));

  const canContinueUnlocked = Effect.fn("ExperimentService.canContinueUnlocked")(function* (
    threadId: string,
  ) {
    const stored = Option.getOrUndefined(yield* store.get(threadId));
    if (stored === undefined) return true;
    const profile = yield* enforceLimits(stored);
    return profile.armed && !TERMINAL_PHASES.has(profile.phase) && profile.phase !== "paused";
  });
  const canContinue = (threadId: string) => withThreadLock(threadId, canContinueUnlocked(threadId));

  const recoverAll = () =>
    store.list().pipe(
      Effect.flatMap((profiles) =>
        Effect.forEach(
          profiles,
          (profile) => withThreadLock(profile.threadId, recoverOne(profile)),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("experiment startup recovery failed", { cause }),
      ),
    );

  return ExperimentService.of({
    preview,
    start,
    get,
    status,
    listFiles,
    readFile,
    apply,
    evaluate,
    settle,
    resume,
    canContinue,
    recoverAll,
  });
});

export const layer = Layer.effect(ExperimentService, make);
