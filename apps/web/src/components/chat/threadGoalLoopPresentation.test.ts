import { describe, expect, it } from "vite-plus/test";
import type { ThreadGoalLoop } from "@t3tools/contracts";

import { describeGoalLoop } from "./threadGoalLoopPresentation";

const exhaustedExperiment: ThreadGoalLoop = {
  kind: "experiment",
  state: "capped",
  mode: "t3",
  iterations: 5,
  maxIterations: 10,
  reason: "Experiment limit reached",
  updatedAt: "2026-09-07T02:00:00.000Z",
  experiment: {
    runId: "run-1",
    configDigest: "sha256:config",
    phase: "exhausted",
    metric: { name: "milliseconds", direction: "minimize", minimumImprovement: 5 },
    experimentsRun: 8,
    experimentsKept: 2,
    experimentsRestored: 6,
    baselineMetric: 250,
    bestMetric: 180,
    lastMetric: 190,
    elapsedSeconds: 900,
    maxExperiments: 8,
    maxTotalSeconds: 900,
    lastError: "Time limit reached",
  },
};

describe("experiment goal loop presentation", () => {
  it("shows bounded progress and the last error", () => {
    expect(describeGoalLoop(exhaustedExperiment)).toMatchObject({
      tone: "capped",
      suffix: "Exp 8/8",
      tooltip:
        "Experiment · Limits exhausted · baseline 250 · best 180 · 8/8 experiments · 15m 0s/15m 0s · last error: Time limit reached",
    });
  });

  it("does not offer resume or continuation after exhaustion", () => {
    expect(describeGoalLoop(exhaustedExperiment)).toMatchObject({
      pauseAction: null,
      canContinue: false,
    });
  });

  it("keeps ordinary loop copy and controls unchanged", () => {
    expect(
      describeGoalLoop({
        kind: "standard",
        state: "running",
        mode: "t3",
        iterations: 3,
        maxIterations: 10,
        updatedAt: "2026-09-07T02:00:00.000Z",
        experiment: null,
      }),
    ).toMatchObject({
      tone: "running",
      tooltip: "Working toward the goal · iteration 3 of 10",
      suffix: "3/10",
      pauseAction: "pause",
    });
  });

  it("offers a restart for a completed loop and nothing else", () => {
    expect(
      describeGoalLoop({
        kind: "standard",
        state: "completed",
        mode: "t3",
        iterations: 3,
        maxIterations: 10,
        updatedAt: "2026-09-07T02:00:00.000Z",
        experiment: null,
      }),
    ).toMatchObject({
      tone: "completed",
      pauseAction: null,
      canContinue: false,
      canReset: true,
    });
  });
});
