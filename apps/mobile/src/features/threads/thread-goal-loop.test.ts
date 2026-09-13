import type { ThreadGoalLoop } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mobileGoalLoopAction,
  mobileGoalLoopRestart,
  mobileGoalLoopStatus,
} from "./thread-goal-loop";

const exhausted: ThreadGoalLoop = {
  kind: "experiment",
  state: "paused",
  mode: "t3",
  iterations: 8,
  maxIterations: 10,
  updatedAt: "2026-09-07T02:00:00.000Z",
  experiment: {
    runId: "run-1",
    configDigest: "sha256:config",
    phase: "exhausted",
    metric: { name: "score", direction: "maximize", minimumImprovement: 0.1 },
    experimentsRun: 8,
    experimentsKept: 2,
    experimentsRestored: 6,
    baselineMetric: 10,
    bestMetric: 12,
    lastMetric: 11,
    elapsedSeconds: 900,
    maxExperiments: 8,
    maxTotalSeconds: 900,
    lastError: "Time limit reached",
  },
};

describe("mobile goal experiment status", () => {
  it("identifies the experiment and its bounded progress", () => {
    expect(mobileGoalLoopStatus(exhausted)).toBe(
      "Experiment · Limits exhausted · 8/8 · 15m 0s/15m 0s",
    );
  });

  it("does not offer a reset or resume after exhaustion", () => {
    expect(mobileGoalLoopAction(exhausted)).toBeNull();
  });
});

describe("mobile goal restart", () => {
  it("restarts a completed loop through a reset", () => {
    expect(
      mobileGoalLoopRestart({
        kind: "standard",
        state: "completed",
        mode: "t3",
        iterations: 3,
        maxIterations: 10,
        reason: null,
        experiment: null,
        updatedAt: "2026-09-07T02:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("never restarts a running loop or a terminal experiment", () => {
    expect(
      mobileGoalLoopRestart({
        kind: "standard",
        state: "running",
        mode: "t3",
        iterations: 1,
        maxIterations: 10,
        reason: null,
        experiment: null,
        updatedAt: "2026-09-07T02:00:00.000Z",
      }),
    ).toBe(false);
    expect(mobileGoalLoopRestart(exhausted)).toBe(false);
  });
});
