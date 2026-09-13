import { assert, describe, it } from "@effect/vitest";

import { ProviderAdapterProcessError } from "../provider/Errors.ts";
import {
  resolveExperimentGoalLoopMode,
  translateExperimentCoordinatorFailure,
} from "./ExperimentCoordinatorLive.ts";

describe("experiment goal-loop mode", () => {
  it("preserves Codex native mode and uses T3 mode for Claude and Pi", () => {
    assert.strictEqual(
      resolveExperimentGoalLoopMode({ providerDriver: "codex", providerInstanceId: "custom" }),
      "native",
    );
    assert.strictEqual(
      resolveExperimentGoalLoopMode({ providerDriver: null, providerInstanceId: "codex" }),
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

describe("experiment coordinator failures", () => {
  it("keeps bounded provider restriction detail without exposing credentials or arguments", () => {
    const secret = "super-secret-bearer-value";
    const argument = "/private/bin/codex --dangerous-flag";
    const translated = translateExperimentCoordinatorFailure(
      "Could not start the restricted experiment provider session.",
      new ProviderAdapterProcessError({
        provider: "codex",
        threadId: "thread-1",
        detail: `Codex experiment MCP inventory did not match the restricted allowlist. authorization=Bearer ${secret}; argv=["${argument}"]`,
      }),
    );

    assert.include(
      translated.message,
      "Codex experiment MCP inventory did not match the restricted allowlist.",
    );
    assert.notInclude(translated.message, secret);
    assert.notInclude(translated.message, argument);
    assert.isAtMost(Array.from(translated.message).length, 2_000);
  });
});
