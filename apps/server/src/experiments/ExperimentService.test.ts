import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { memoryLayer } from "../persistence/ThreadExperiments.ts";
import {
  ExperimentCoordinator,
  ExperimentService,
  layer as experimentLayer,
  type ExperimentCoordinatorShape,
} from "./ExperimentService.ts";
import type { ExperimentThreadContext } from "./Model.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRepo(maxExperiments = 10): string {
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
      checks: [["node", "-e", "process.exit(0)"]],
      limits: {
        maxExperiments,
        maxApplyBytes: 10_000,
        maxOutputBytes: 10_000,
        evaluatorTimeoutSeconds: 10,
        checkTimeoutSeconds: 10,
        maxTotalSeconds: 600,
      },
    }),
  );
  return root;
}

function testLayer(contexts: Map<string, ExperimentThreadContext>) {
  const started: Array<string> = [];
  const startsByThread = new Map<string, number>();
  const coordinator: ExperimentCoordinatorShape = {
    resolveThread: (threadId) =>
      Effect.sync(() => {
        const context = contexts.get(threadId);
        if (context === undefined) throw new Error(`missing context ${threadId}`);
        return context;
      }),
    startProvider: (input) =>
      Effect.sync(() => {
        const context = contexts.get(input.threadId)!;
        const count = (startsByThread.get(input.threadId) ?? 0) + 1;
        startsByThread.set(input.threadId, count);
        const providerSessionId = `experiment-${input.threadId}-${count}`;
        contexts.set(input.threadId, { ...context, providerSessionId });
        started.push(input.threadId);
        return { providerSessionId };
      }),
    stopProvider: () => Effect.void,
    activateGoal: () => Effect.void,
    syncSummary: () => Effect.void,
    holdGoal: () => Effect.void,
  };
  return {
    started,
    layer: experimentLayer.pipe(
      Layer.provide(memoryLayer),
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

describe("ExperimentService", () => {
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
      ["thread-2", context("thread-2", cwd)],
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
        hypothesis: "Interrupted candidate",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      yield* service.recoverAll();
      assert.strictEqual(readFileSync(path.join(cwd, "score.txt"), "utf8"), "1\n");
      const summary = yield* service.get({ threadId: "thread-1" });
      assert.strictEqual(summary?.phase, "ready");
      assert.strictEqual(summary?.experimentsRestored, 1);
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

      const resumed = yield* service.resume("thread-1");
      assert.strictEqual(resumed.phase, "ready");
      assert.strictEqual(resumed.experimentsRun, 0);
      assert.deepEqual(fixture.started, ["thread-1", "thread-1"]);
      const oldIdentity = yield* service
        .status({
          threadId: "thread-1",
          providerInstanceId: "claude",
          providerSessionId: "experiment-thread-1-1",
          runId: started.runId,
        })
        .pipe(Effect.result);
      assert(Result.isFailure(oldIdentity));
      const current = yield* service.status({
        threadId: "thread-1",
        providerInstanceId: "claude",
        providerSessionId: "experiment-thread-1-2",
        runId: started.runId,
      });
      assert.strictEqual(current.phase, "ready");
    }).pipe(Effect.provide(fixture.layer));
  });
});
