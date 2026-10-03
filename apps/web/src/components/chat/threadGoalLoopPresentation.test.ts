import { describe, expect, it } from "vite-plus/test";
import type { ThreadGoalLoop } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { describeGoalLoop } from "./threadGoalLoopPresentation";

function loop(state: ThreadGoalLoop["state"], reason?: string): ThreadGoalLoop {
  return {
    state,
    mode: "t3",
    iterations: 3,
    maxIterations: 10,
    updatedAt: DateTime.makeUnsafe("2026-09-07T02:00:00.000Z"),
    ...(reason === undefined ? {} : { reason }),
  };
}

describe("goal loop presentation", () => {
  it("offers pause while running", () => {
    expect(describeGoalLoop(loop("running"))).toMatchObject({
      label: "Running",
      tone: "running",
      pauseAction: "pause",
      canContinue: false,
    });
  });

  it("offers resume with the blocked reason", () => {
    expect(describeGoalLoop(loop("blocked", "Needs input"))).toMatchObject({
      label: "Blocked · Needs input",
      pauseAction: "resume",
    });
  });

  it("offers continuation only after the cap", () => {
    expect(describeGoalLoop(loop("capped"))).toMatchObject({
      canContinue: true,
      canReset: false,
    });
  });

  it("offers reset only after completion", () => {
    expect(describeGoalLoop(loop("completed"))).toMatchObject({
      pauseAction: null,
      canContinue: false,
      canReset: true,
    });
  });
});
