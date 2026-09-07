import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CheckpointRef,
  CommandId,
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ThreadGoalLoop,
} from "@t3tools/contracts";
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ThreadExperimentStore,
  type ThreadExperimentStoreShape,
} from "../persistence/ThreadExperiments.ts";
import {
  ExperimentCoordinator,
  ExperimentService,
  layer as experimentLayer,
  type ExperimentCoordinatorShape,
} from "./ExperimentService.ts";
import * as ExperimentLifecycleReactor from "./ExperimentLifecycleReactor.ts";
import { ExperimentError, type ExperimentProfile, type ExperimentThreadContext } from "./Model.ts";
import { ServerActivation } from "../serverActivation.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRepo(
  maxExperiments = 10,
  maxTotalSeconds = 600,
  checks: ReadonlyArray<ReadonlyArray<string>> = [["node", "-e", "process.exit(0)"]],
): string {
  const root = mkdtempSync(path.join(tmpdir(), "t3-experiment-service-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "experiment/test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, "score.txt"), "1\n");
  writeFileSync(path.join(root, "untouched.txt"), "owned by user\n");
  execFileSync("git", ["add", "score.txt", "untouched.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });
  mkdirSync(path.join(root, ".auto"));
  writeFileSync(
    path.join(root, ".auto/config.json"),
    JSON.stringify({
      version: 1,
      branch: "experiment/test",
      files: ["score.txt"],
      evaluator: {
        argv: [
          "node",
          "-e",
          "const fs=require('fs');const score=Number(fs.readFileSync('score.txt','utf8'));process.stdout.write(JSON.stringify({metrics:{score}}))",
        ],
        metric: "score",
        direction: "higher",
        minimumImprovement: 0.5,
      },
      checks,
      limits: {
        maxExperiments,
        maxApplyBytes: 10_000,
        maxOutputBytes: 10_000,
        evaluatorTimeoutSeconds: 10,
        checkTimeoutSeconds: 10,
        maxTotalSeconds,
      },
    }),
  );
  return root;
}

function testLayer(
  contexts: Map<string, ExperimentThreadContext>,
  options: {
    readonly failActivation?: boolean;
    readonly failProviderStart?: boolean;
    readonly rejectSyncBeforeActivation?: boolean;
    readonly beforeStartProvider?: (count: number) => Promise<void>;
    readonly failHold?: boolean;
    readonly onStopProvider?: () => void;
    readonly rejectSync?: () => boolean;
    readonly onSave?: (profile: ExperimentProfile) => void;
  } = {},
) {
  const started: Array<string> = [];
  const stopped: Array<string> = [];
  const stoppedWhileArmed: Array<boolean | undefined> = [];
  const held: Array<{ readonly action: "pause" | "block" | "complete"; readonly reason: string }> =
    [];
  const lifecycle: Array<"activate" | "sync"> = [];
  const holds: Array<"pause" | "block" | "complete"> = [];
  let activated = false;
  const rows = new Map<string, ExperimentProfile>();
  const saved: Array<ExperimentProfile> = [];
  const startsByThread = new Map<string, number>();
  const coordinator: ExperimentCoordinatorShape = {
    resolveThread: (threadId) =>
      Effect.sync(() => {
        const context = contexts.get(threadId);
        if (context === undefined) throw new Error(`missing context ${threadId}`);
        return context;
      }),
    startProvider: (input) =>
      options.failProviderStart
        ? Effect.fail(
            new ExperimentError({
              code: "persistence_failed",
              message: "restricted provider failed to start",
            }),
          )
        : Effect.promise(async () => {
            const context = contexts.get(input.threadId)!;
            const count = (startsByThread.get(input.threadId) ?? 0) + 1;
            startsByThread.set(input.threadId, count);
            await options.beforeStartProvider?.(count);
            const providerSessionId = `experiment-${input.threadId}-${count}`;
            contexts.set(input.threadId, {
              ...context,
              providerSessionId,
              providerGeneration: input.generation,
            });
            started.push(input.threadId);
            return {
              threadId: input.threadId,
              providerInstanceId: input.providerInstanceId,
              providerSessionId,
              runId: input.runId,
              generation: input.generation,
            };
          }),
    stopProvider: (input) =>
      Effect.sync(() => {
        stopped.push(input.threadId);
        stoppedWhileArmed.push(rows.get(input.threadId)?.armed);
        options.onStopProvider?.();
      }),
    activateGoal: () =>
      options.failActivation
        ? Effect.fail(
            new ExperimentError({
              code: "persistence_failed",
              message: "activation failed",
            }),
          )
        : Effect.sync(() => {
            activated = true;
            lifecycle.push("activate");
          }),
    syncSummary: () =>
      Effect.gen(function* () {
        lifecycle.push("sync");
        if ((options.rejectSyncBeforeActivation && !activated) || options.rejectSync?.()) {
          return yield* new ExperimentError({
            code: "persistence_failed",
            message: "Could not synchronize experiment progress.",
          });
        }
      }),
    holdGoal: (input) =>
      Effect.gen(function* () {
        held.push(input);
        holds.push(input.action);
        if (options.failHold) {
          return yield* new ExperimentError({
            code: "persistence_failed",
            message: "goal does not exist",
          });
        }
      }),
  };
  const store: ThreadExperimentStoreShape = {
    get: (threadId) =>
      Effect.sync(() => {
        const profile = rows.get(threadId);
        return Option.fromUndefinedOr(profile === undefined ? undefined : structuredClone(profile));
      }),
    save: (profile) =>
      Effect.sync(() => {
        rows.set(profile.threadId, structuredClone(profile));
        saved.push(structuredClone(profile));
        options.onSave?.(profile);
      }),
    list: () => Effect.sync(() => [...rows.values()].map((profile) => structuredClone(profile))),
  };
  return {
    rows,
    saved,
    started,
    stopped,
    stoppedWhileArmed,
    held,
    lifecycle,
    holds,
    layer: experimentLayer.pipe(
      Layer.provide(Layer.succeed(ThreadExperimentStore, store)),
      Layer.provide(Layer.succeed(ExperimentCoordinator, coordinator)),
    ),
  };
}

function context(threadId: string, cwd: string): ExperimentThreadContext {
  return {
    threadId,
    cwd,
    providerInstanceId: "claude",
    providerSessionId: `ordinary-${threadId}`,
    providerDriver: "claudeAgent",
    providerSupported: true,
    idle: true,
    pendingChildRun: false,
  };
}

function goalLoopUpdatedEvent(input: {
  readonly kind: ThreadGoalLoop["kind"];
  readonly state?: ThreadGoalLoop["state"];
  readonly resumed?: boolean;
}): OrchestrationEvent {
  const threadId = ThreadId.make("thread-1");
  return {
    sequence: 1,
    eventId: EventId.make(`goal-loop-${input.kind}-${input.resumed === true ? "resume" : "sync"}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-09-07T05:38:30.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.goal-loop-updated",
    payload: {
      threadId,
      loop: {
        kind: input.kind,
        state: input.state ?? "idle",
        mode: "native",
        iterations: 0,
        maxIterations: 10,
        reason: null,
        experiment: null,
        updatedAt: "2026-09-07T05:38:30.000Z",
      },
      ...(input.resumed === true ? { resumed: true } : {}),
    },
  };
}

function threadGoalClearedEvent(): OrchestrationEvent {
  const threadId = ThreadId.make("thread-1");
  return {
    sequence: 1,
    eventId: EventId.make("thread-goal-cleared"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-09-07T05:40:25.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.meta-updated",
    payload: {
      threadId,
      goal: null,
      updatedAt: "2026-09-07T05:40:25.000Z",
    },
  };
}

function turnDiffCompletedEvent(): OrchestrationEvent {
  const threadId = ThreadId.make("thread-1");
  return {
    sequence: 2,
    eventId: EventId.make("thread-turn-diff-completed"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-09-07T05:56:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-diff-completed",
    payload: {
      threadId,
      turnId: TurnId.make("experiment-final-turn"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread-1/final"),
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-09-07T05:56:00.000Z",
    },
  };
}

describe("ExperimentService", () => {
  it.effect("does not block a goal that was never activated", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts, { failProviderStart: true });
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service
        .start({
          threadId: "thread-1",
          objective: "Improve score",
          confirmationId: preview.confirmationId,
        })
        .pipe(Effect.result);

      assert(Result.isFailure(started));
      assert.deepEqual(fixture.held, []);
      assert.strictEqual((yield* service.get({ threadId: "thread-1" }))?.phase, "failed");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("blocks an activated goal when a live experiment fails closed", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      contexts.set("thread-1", {
        ...contexts.get("thread-1")!,
        providerSessionId: "externally-replaced-session",
      });

      assert.strictEqual((yield* service.get({ threadId: "thread-1" }))?.phase, "failed");
      assert.deepEqual(
        fixture.held.map((entry) => entry.action),
        ["block"],
      );
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("establishes the baseline before the first goal-loop synchronization", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts, { rejectSyncBeforeActivation: true });
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });

      assert.strictEqual(started.phase, "ready");
      assert.deepEqual(fixture.lifecycle, ["activate"]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect(
    "runs the baseline before arming, keeps strict improvements, and restores rejects",
    () => {
      const cwd = makeRepo();
      const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
      const fixture = testLayer(contexts);
      return Effect.gen(function* () {
        const service = yield* ExperimentService;
        const preview = yield* service.preview({
          threadId: "thread-1",
          objective: "Improve score",
        });
        const started = yield* service.start({
          threadId: "thread-1",
          objective: "Improve score",
          confirmationId: preview.confirmationId,
        });
        assert.strictEqual(started.phase, "ready");
        assert.strictEqual(started.baselineMetric, 1);
        assert.deepEqual(fixture.started, ["thread-1"]);

        const identity = {
          threadId: "thread-1",
          providerInstanceId: "claude",
          providerSessionId: "experiment-thread-1-1",
          runId: started.runId,
          generation: 1,
        };
        yield* service.apply({
          ...identity,
          hypothesis: "Increase the score",
          changes: [{ path: "score.txt", content: "2\n" }],
        });
        const kept = yield* service.evaluate(identity);
        assert.strictEqual(kept.outcome, "kept");
        assert.strictEqual(kept.metric, 2);
        assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "2\n");
        assert.strictEqual(
          readFileSync(path.join(cwd, "untouched.txt"), "utf8"),
          "owned by user\n",
        );

        yield* service.apply({
          ...identity,
          hypothesis: "Try a lower score",
          changes: [{ path: "score.txt", content: "1\n" }],
        });
        const rejected = yield* service.evaluate(identity);
        assert.strictEqual(rejected.outcome, "restored");
        assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "2\n");
        const summary = yield* service.status(identity);
        assert.strictEqual(summary.experimentsRun, 2);
        assert.strictEqual(summary.experimentsKept, 1);
        assert.strictEqual(summary.experimentsRestored, 1);
      }).pipe(Effect.provide(fixture.layer));
    },
  );

  it.effect("consumes confirmations once and lets exactly one thread claim a cwd", () => {
    const cwd = makeRepo();
    const contexts = new Map([
      ["thread-1", context("thread-1", cwd)],
      ["thread-2", context("thread-2", `${cwd}${path.sep}.`)],
    ]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const first = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const second = yield* service.preview({ threadId: "thread-2", objective: "Improve score" });
      const results = yield* Effect.all(
        [
          service
            .start({
              threadId: "thread-1",
              objective: "Improve score",
              confirmationId: first.confirmationId,
            })
            .pipe(Effect.result),
          service
            .start({
              threadId: "thread-2",
              objective: "Improve score",
              confirmationId: second.confirmationId,
            })
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter(Result.isSuccess).length, 1);
      assert.strictEqual(results.filter(Result.isFailure).length, 1);

      const duplicate = yield* service
        .start({
          threadId: "thread-1",
          objective: "Improve score",
          confirmationId: first.confirmationId,
        })
        .pipe(Effect.result);
      assert(Result.isFailure(duplicate));
      assert.strictEqual(duplicate.failure.code, "confirmation_invalid");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("fails closed without restoring across an unrelated external edit", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      const identity = {
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
      };
      yield* service.apply({
        ...identity,
        hypothesis: "Increase the score",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      writeFileSync(path.join(cwd, "untouched.txt"), "external edit\n");
      const result = yield* service.evaluate(identity).pipe(Effect.result);
      assert(Result.isFailure(result));
      assert.strictEqual(result.failure.code, "external_drift");
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "2\n");
      assert.strictEqual(readFileSync(path.join(cwd, "untouched.txt"), "utf8"), "external edit\n");
      const summary = yield* service.get({ threadId: "thread-1" });
      assert.strictEqual(summary?.phase, "failed");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("restores an owned pending candidate during startup recovery", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      yield* service.apply({
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
        hypothesis: "Interrupted candidate",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      yield* service.recoverAll();
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "1\n");
      const summary = yield* service.get({ threadId: "thread-1" });
      assert.strictEqual(summary?.phase, "paused");
      assert.strictEqual(summary?.experimentsRestored, 1);
      assert.deepEqual(fixture.holds, ["pause"]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("recovers an apply rename that happened before its path checkpoint", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      const identity = {
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
      };
      yield* service.apply({
        ...identity,
        hypothesis: "Interrupted after rename",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      const persisted = fixture.rows.get("thread-1");
      assert(persisted?.pending !== null && persisted?.pending !== undefined);
      fixture.rows.set("thread-1", {
        ...persisted,
        phase: "applying",
        armed: false,
        pending: { ...persisted.pending, writtenPaths: [] },
      });

      yield* service.recoverAll();
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "1\n");
      assert.strictEqual((yield* service.get({ threadId: "thread-1" }))?.phase, "paused");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("recovers a restore rename that happened before its path checkpoint", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      yield* service.apply({
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
        hypothesis: "Interrupted during restore",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      const persisted = fixture.rows.get("thread-1");
      assert(persisted?.pending !== null && persisted?.pending !== undefined);
      writeFileSync(path.join(cwd, "score.txt"), "1\n");
      fixture.rows.set("thread-1", {
        ...persisted,
        phase: "restoring",
        armed: false,
        pending: { ...persisted.pending, restoredPaths: [] },
      });

      yield* service.recoverAll();
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "1\n");
      assert.strictEqual((yield* service.get({ threadId: "thread-1" }))?.phase, "paused");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("restores the snapshot mode when recovery finds original content", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      yield* service.apply({
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
        hypothesis: "Interrupted mode restore",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      const persisted = fixture.rows.get("thread-1");
      assert(persisted?.pending !== null && persisted?.pending !== undefined);
      writeFileSync(path.join(cwd, "score.txt"), "1\n");
      chmodSync(path.join(cwd, "score.txt"), 0o755);
      fixture.rows.set("thread-1", {
        ...persisted,
        phase: "restoring",
        armed: false,
        pending: { ...persisted.pending, restoredPaths: [] },
      });

      yield* service.recoverAll();
      assert.strictEqual(statSync(path.join(cwd, "score.txt")).mode & 0o777, 0o644);
      assert.strictEqual((yield* service.get({ threadId: "thread-1" }))?.phase, "paused");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("pauses an inert ready profile during startup recovery", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts, { failHold: true });
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      const persisted = fixture.rows.get("thread-1");
      assert(persisted !== undefined);
      fixture.rows.set("thread-1", {
        ...persisted,
        phase: "ready",
        armed: false,
        providerSessionActive: false,
      });

      yield* service.recoverAll();
      const recovered = yield* service.get({ threadId: "thread-1" });
      assert.strictEqual(recovered?.phase, "paused");
      assert.match(recovered?.lastError ?? "", /fresh restricted provider session/);
      assert.deepEqual(fixture.holds, ["pause"]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("unstages and restores a candidate rejected by a normal commit hook", () => {
    const cwd = makeRepo();
    const hook = path.join(cwd, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      const identity = {
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
      };
      yield* service.apply({
        ...identity,
        hypothesis: "Candidate rejected by hook",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      const evaluated = yield* service.evaluate(identity);

      assert.strictEqual(evaluated.outcome, "restored");
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "1\n");
      assert.strictEqual(
        execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8" }),
        "",
      );
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("restores instead of keeping when a commit hook exceeds the campaign deadline", () => {
    const cwd = makeRepo(10, 1);
    const hook = path.join(cwd, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nsleep 2\n");
    chmodSync(hook, 0o755);
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const identity = {
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
      };
      yield* service.apply({
        ...identity,
        hypothesis: "Hook exceeds campaign",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      const evaluated = yield* service.evaluate(identity);

      assert.strictEqual(evaluated.outcome, "restored");
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "1\n");
      assert.strictEqual(
        execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
        before,
      );
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("treats the goal-loop cap as resumable without resetting experiment budgets", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      yield* service.settle({
        threadId: "thread-1",
        terminal: "capped",
        reason: "Ordinary continuation cap reached.",
      });
      const paused = yield* service.get({ threadId: "thread-1" });
      assert.strictEqual(paused?.phase, "paused");
      assert.strictEqual(paused?.experimentsRun, 0);
      assert.strictEqual(paused?.maxTotalSeconds, started.maxTotalSeconds);
      assert.deepEqual(fixture.stoppedWhileArmed, [false]);

      const resumed = yield* service.resume("thread-1");
      assert.strictEqual(resumed.phase, "ready");
      assert.strictEqual(resumed.experimentsRun, 0);
      assert.deepEqual(fixture.started, ["thread-1", "thread-1"]);
      const oldIdentity = yield* service
        .status({
          threadId: "thread-1",
          providerInstanceId: "claude",
          providerSessionId: "experiment-thread-1-2",
          runId: started.runId,
          generation: 1,
        })
        .pipe(Effect.result);
      assert(Result.isFailure(oldIdentity));
      const current = yield* service.status({
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-2",
        runId: started.runId,
        generation: 2,
      });
      assert.strictEqual(current.phase, "ready");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("resumes a paused experiment only for an explicit experiment resume event", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    let observeStop = false;
    let markFinalStop = () => {};
    const finalStop = new Promise<void>((resolve) => {
      markFinalStop = resolve;
    });
    const fixture = testLayer(contexts, {
      onStopProvider: () => {
        if (observeStop) markFinalStop();
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const activation = yield* Deferred.make<void>();
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.gen(function* () {
          const service = yield* ExperimentService;
          const preview = yield* service.preview({
            threadId: "thread-1",
            objective: "Improve score",
          });
          yield* service.start({
            threadId: "thread-1",
            objective: "Improve score",
            confirmationId: preview.confirmationId,
          });
          yield* service.settle({
            threadId: "thread-1",
            terminal: "pause",
            reason: "Paused in the browser",
          });

          const lifecycle = yield* ExperimentLifecycleReactor.ExperimentLifecycleReactor;
          yield* lifecycle.start();
          yield* Deferred.succeed(activation, undefined);
          observeStop = true;
          yield* Queue.offer(events, goalLoopUpdatedEvent({ kind: "experiment", resumed: true }));
          yield* Queue.offer(events, goalLoopUpdatedEvent({ kind: "experiment" }));
          yield* Queue.offer(events, goalLoopUpdatedEvent({ kind: "standard", resumed: true }));
          yield* Queue.offer(events, goalLoopUpdatedEvent({ kind: "experiment", state: "paused" }));
          yield* Effect.promise(() => finalStop);

          assert.deepEqual(fixture.started, ["thread-1", "thread-1"]);
          assert.strictEqual(fixture.stopped.length, 2);
        }).pipe(
          Effect.provide(
            ExperimentLifecycleReactor.layer.pipe(
              Layer.provideMerge(fixture.layer),
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
                    streamDomainEvents: Stream.fromQueue(events),
                  }),
                  Layer.succeed(ServerActivation, Deferred.await(activation)),
                ),
              ),
            ),
          ),
        );
      }),
    );
  });

  it.effect("clears a paused experiment and releases its worktree claim", () => {
    const cwd = makeRepo();
    const contexts = new Map([
      ["thread-1", context("thread-1", cwd)],
      ["thread-2", context("thread-2", cwd)],
    ]);
    let goalCleared = false;
    let markCompleted = () => {};
    const completed = new Promise<void>((resolve) => {
      markCompleted = resolve;
    });
    const fixture = testLayer(contexts, {
      rejectSync: () => goalCleared,
      onSave: (profile) => {
        if (profile.threadId === "thread-1" && profile.phase === "completed") markCompleted();
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const activation = yield* Deferred.make<void>();
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.gen(function* () {
          const service = yield* ExperimentService;
          const preview = yield* service.preview({
            threadId: "thread-1",
            objective: "Improve score",
          });
          yield* service.start({
            threadId: "thread-1",
            objective: "Improve score",
            confirmationId: preview.confirmationId,
          });
          yield* service.settle({
            threadId: "thread-1",
            terminal: "pause",
            reason: "Paused in the browser",
          });

          const lifecycle = yield* ExperimentLifecycleReactor.ExperimentLifecycleReactor;
          yield* lifecycle.start();
          yield* Deferred.succeed(activation, undefined);
          const savesBeforeClear = fixture.saved.length;
          goalCleared = true;
          yield* Queue.offer(events, {
            ...goalLoopUpdatedEvent({ kind: "experiment", state: "paused" }),
            commandId: CommandId.make("server:experiment-progress:thread-1:test"),
          });
          yield* Queue.offer(events, threadGoalClearedEvent());
          yield* Effect.promise(() => completed);

          assert.strictEqual(fixture.rows.get("thread-1")?.phase, "completed");
          assert.strictEqual(fixture.saved.length - savesBeforeClear, 2);
          const next = yield* service.preview({
            threadId: "thread-2",
            objective: "Reuse the worktree",
          });
          assert.strictEqual(next.cwd, realpathSync.native(cwd));
        }).pipe(
          Effect.provide(
            ExperimentLifecycleReactor.layer.pipe(
              Layer.provideMerge(fixture.layer),
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
                    streamDomainEvents: Stream.fromQueue(events),
                  }),
                  Layer.succeed(ServerActivation, Deferred.await(activation)),
                ),
              ),
            ),
          ),
        );
      }),
    );
  });

  it.effect("does not retain an expired fully disarmed paused worktree claim", () => {
    const cwd = makeRepo(10, 1);
    const contexts = new Map([
      ["thread-1", context("thread-1", cwd)],
      ["thread-2", context("thread-2", cwd)],
    ]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      yield* service.settle({
        threadId: "thread-1",
        terminal: "pause",
        reason: "Paused until later",
      });
      yield* TestClock.adjust("2 seconds");

      const next = yield* service.preview({
        threadId: "thread-2",
        objective: "Reuse expired worktree",
      });
      assert.strictEqual(next.cwd, realpathSync.native(cwd));
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("defers completed native provider teardown until the final turn diff", () => {
    const cwd = makeRepo();
    const contexts = new Map([
      ["thread-1", context("thread-1", cwd)],
      ["thread-2", context("thread-2", cwd)],
    ]);
    let markCompleted = () => {};
    let markStopped = () => {};
    const completed = new Promise<void>((resolve) => {
      markCompleted = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      markStopped = resolve;
    });
    const fixture = testLayer(contexts, {
      onSave: (profile) => {
        if (profile.phase === "completed" && profile.providerSessionActive) markCompleted();
      },
      onStopProvider: () => markStopped(),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const activation = yield* Deferred.make<void>();
        const events = yield* Queue.unbounded<OrchestrationEvent>();
        yield* Effect.gen(function* () {
          const service = yield* ExperimentService;
          const secondPreview = yield* service.preview({
            threadId: "thread-2",
            objective: "Reuse the worktree",
          });
          const preview = yield* service.preview({
            threadId: "thread-1",
            objective: "Improve score",
          });
          const started = yield* service.start({
            threadId: "thread-1",
            objective: "Improve score",
            confirmationId: preview.confirmationId,
          });

          const lifecycle = yield* ExperimentLifecycleReactor.ExperimentLifecycleReactor;
          yield* lifecycle.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Queue.offer(
            events,
            goalLoopUpdatedEvent({ kind: "experiment", state: "completed" }),
          );
          yield* Effect.promise(() => completed);

          assert.strictEqual(fixture.stopped.length, 0);
          assert.strictEqual(fixture.rows.get("thread-1")?.armed, false);
          assert.strictEqual(fixture.rows.get("thread-1")?.providerSessionActive, true);
          const competingPreview = yield* service
            .preview({ threadId: "thread-2", objective: "Reuse the worktree" })
            .pipe(Effect.result);
          const competingStart = yield* service
            .start({
              threadId: "thread-2",
              objective: "Reuse the worktree",
              confirmationId: secondPreview.confirmationId,
            })
            .pipe(Effect.result);
          assert(Result.isFailure(competingPreview));
          assert.strictEqual(competingPreview.failure.code, "invalid_phase");
          assert(Result.isFailure(competingStart));
          assert.strictEqual(competingStart.failure.code, "invalid_phase");
          const mutation = yield* service
            .apply({
              threadId: "thread-1",
              providerInstanceId: "claude",
              providerSessionId: "experiment-thread-1-1",
              runId: started.runId,
              generation: 1,
              hypothesis: "Too late",
              changes: [],
            })
            .pipe(Effect.result);
          assert(Result.isFailure(mutation));
          assert.strictEqual(mutation.failure.code, "invalid_phase");

          yield* Queue.offer(events, turnDiffCompletedEvent());
          yield* Effect.promise(() => stopped);
          assert.strictEqual(fixture.stopped.length, 1);
          assert.strictEqual(fixture.rows.get("thread-1")?.phase, "completed");
          assert.strictEqual(fixture.rows.get("thread-1")?.providerSessionActive, false);
          const releasedPreview = yield* service.preview({
            threadId: "thread-2",
            objective: "Reuse the worktree",
          });
          assert.strictEqual(releasedPreview.cwd, realpathSync.native(cwd));
        }).pipe(
          Effect.provide(
            ExperimentLifecycleReactor.layer.pipe(
              Layer.provideMerge(fixture.layer),
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
                    streamDomainEvents: Stream.fromQueue(events),
                  }),
                  Layer.succeed(ServerActivation, Deferred.await(activation)),
                ),
              ),
            ),
          ),
        );
      }),
    );
  });

  it.effect("stops a provider that resumes while settlement waits for the thread lock", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    let releaseSecondStart = () => {};
    let markSecondStartReached = () => {};
    const secondStartReached = new Promise<void>((resolve) => {
      markSecondStartReached = resolve;
    });
    const secondStartGate = new Promise<void>((resolve) => {
      releaseSecondStart = resolve;
    });
    const fixture = testLayer(contexts, {
      beforeStartProvider: (count) => {
        if (count !== 2) return Promise.resolve();
        markSecondStartReached();
        return secondStartGate;
      },
    });
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      yield* service.settle({
        threadId: "thread-1",
        terminal: "pause",
        reason: "Initial pause",
      });
      fixture.stopped.splice(0);

      const resumeFiber = yield* Effect.forkChild(service.resume("thread-1"));
      yield* Effect.promise(() => secondStartReached);
      const settleFiber = yield* Effect.forkChild(
        service.settle({
          threadId: "thread-1",
          terminal: "pause",
          reason: "Pause raced with resume",
        }),
      );
      releaseSecondStart();
      yield* Fiber.join(resumeFiber);
      yield* Fiber.join(settleFiber);

      assert.deepEqual(fixture.stopped, ["thread-1"]);
      assert.strictEqual((yield* service.get({ threadId: "thread-1" }))?.phase, "paused");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("restores a candidate when a check changes only its file mode", () => {
    const cwd = makeRepo(10, 600, [
      [
        "node",
        "-e",
        "const fs=require('fs');if(fs.readFileSync('score.txt','utf8').trim()==='2')fs.chmodSync('score.txt',0o755)",
      ],
    ]);
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      const identity = {
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
      };
      yield* service.apply({
        ...identity,
        hypothesis: "Increase the score without changing its mode",
        changes: [{ path: "score.txt", content: "2\n" }],
      });

      const evaluated = yield* service.evaluate(identity);

      assert.strictEqual(evaluated.outcome, "restored");
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "1\n");
      assert.strictEqual(statSync(path.join(cwd, "score.txt")).mode & 0o777, 0o644);
      assert.strictEqual((yield* service.get({ threadId: "thread-1" }))?.experimentsKept, 0);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("ignores a terminal profile whose old repository no longer exists", () => {
    const cwd = makeRepo();
    const contexts = new Map([
      ["thread-1", context("thread-1", cwd)],
      ["thread-2", context("thread-2", cwd)],
    ]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const first = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: first.confirmationId,
      });
      yield* service.settle({
        threadId: "thread-1",
        terminal: "clear",
        reason: "Finished",
      });
      const terminal = fixture.rows.get("thread-1");
      assert(terminal !== undefined);
      fixture.rows.set("thread-1", { ...terminal, cwd: path.join(cwd, "missing") });

      const preview = yield* service.preview({ threadId: "thread-2", objective: "Try again" });
      assert.strictEqual(preview.cwd, realpathSync.native(cwd));

      fixture.rows.set("thread-1", {
        ...terminal,
        phase: "paused",
        cwd: path.join(cwd, "missing"),
      });
      const blocked = yield* service
        .preview({ threadId: "thread-2", objective: "Try again" })
        .pipe(Effect.result);
      assert(Result.isFailure(blocked));
      assert.strictEqual(blocked.failure.code, "unsafe_repository");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("restores an applied candidate before exhausting the wall-clock deadline", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts);
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const started = yield* service.start({
        threadId: "thread-1",
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      yield* service.apply({
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-1",
        runId: started.runId,
        generation: 1,
        hypothesis: "Candidate at the campaign deadline",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      yield* TestClock.adjust("601 seconds");
      const summary = yield* service.get({ threadId: "thread-1" });
      assert.strictEqual(summary?.phase, "exhausted");
      assert.strictEqual(summary?.experimentsRun, 1);
      assert.strictEqual(summary?.experimentsRestored, 1);
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "1\n");
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("revokes the restricted provider when goal activation fails", () => {
    const cwd = makeRepo();
    const contexts = new Map([["thread-1", context("thread-1", cwd)]]);
    const fixture = testLayer(contexts, { failActivation: true });
    return Effect.gen(function* () {
      const service = yield* ExperimentService;
      const preview = yield* service.preview({ threadId: "thread-1", objective: "Improve score" });
      const result = yield* service
        .start({
          threadId: "thread-1",
          objective: "Improve score",
          confirmationId: preview.confirmationId,
        })
        .pipe(Effect.result);
      assert(Result.isFailure(result));
      assert.deepEqual(fixture.started, ["thread-1"]);
      assert.deepEqual(fixture.stopped, ["thread-1"]);
      const summary = yield* service.get({ threadId: "thread-1" });
      assert.strictEqual(summary?.phase, "failed");
    }).pipe(Effect.provide(fixture.layer));
  });
});
