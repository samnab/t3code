import type { ThreadGoalLoop } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  mobileGoalLoopAction,
  mobileGoalLoopRestart,
  mobileGoalLoopStatus,
} from "./thread-goal-loop";

function loop(state: ThreadGoalLoop["state"]): ThreadGoalLoop {
  return {
    state,
    mode: "t3",
    iterations: 3,
    maxIterations: 10,
    reason: null,
    updatedAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
  };
}

describe("mobile goal loop presentation", () => {
  it("maps live states to the one available primary action", () => {
    expect(mobileGoalLoopAction(loop("running"))).toBe("pause");
    expect(mobileGoalLoopAction(loop("blocked"))).toBe("resume");
    expect(mobileGoalLoopAction(loop("capped"))).toBe("continue");
    expect(mobileGoalLoopAction(loop("completed"))).toBeNull();
  });

  it("labels progress and only restarts completed loops", () => {
    expect(mobileGoalLoopStatus(loop("running"))).toBe("3/10");
    expect(mobileGoalLoopStatus(loop("paused"))).toBe("Paused");
    expect(mobileGoalLoopRestart(loop("completed"))).toBe(true);
    expect(mobileGoalLoopRestart(loop("running"))).toBe(false);
  });
});
