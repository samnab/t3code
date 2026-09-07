import type { ThreadGoalLoop } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mobileGoalLoopAction, mobileGoalLoopStatus } from "./thread-goal-loop";

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
