import { assert, describe, it } from "@effect/vitest";

import { resolveExperimentGoalLoopMode } from "./ExperimentCoordinatorLive.ts";

describe("experiment goal-loop mode", () => {
  it("preserves Codex native mode and uses T3 mode for Claude and Pi", () => {
    assert.strictEqual(
      resolveExperimentGoalLoopMode({ providerDriver: "codex", providerInstanceId: "custom" }),
      "native",
    );
    assert.strictEqual(
      resolveExperimentGoalLoopMode({
        providerDriver: "claudeAgent",
        providerInstanceId: "claude",
      }),
      "t3",
    );
    assert.strictEqual(
      resolveExperimentGoalLoopMode({ providerDriver: "pi", providerInstanceId: "pi" }),
      "t3",
    );
  });
});
