import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

describe("RTK Codex developer instructions", () => {
  const runtime = { model: "gpt-5.4", reasoningEffort: "high" };

  it("adds RTK command guidance only for sessions that attached RTK", () => {
    const attached = buildCodexDeveloperInstructions("default", runtime, true, true);
    const detached = buildCodexDeveloperInstructions("default", runtime, true, false);

    NodeAssert.match(attached, /<rtk_instructions>/);
    NodeAssert.match(attached, /Prefix supported shell commands with `rtk`/);
    NodeAssert.match(attached, /`RTK_DISABLED=1 <command>`/);
    NodeAssert.doesNotMatch(detached, /<rtk_instructions>/);
  });
});
