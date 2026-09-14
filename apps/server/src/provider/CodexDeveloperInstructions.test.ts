import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

describe("RTK Codex developer instructions", () => {
  const runtime = { model: "gpt-5.4", reasoningEffort: "high" };

  it("teaches the full RTK policy only for sessions that attached RTK", () => {
    const attached = buildCodexDeveloperInstructions("default", runtime, true, true);

    NodeAssert.match(attached, /<rtk_instructions>/);
    // Prefix supported commands, including every command in a chain.
    NodeAssert.match(attached, /Prefix every shell command with `rtk`/);
    NodeAssert.match(attached, /rtk git add \. && rtk git commit/);
    // Condensed output is the complete result; proxy only rescues unusable output.
    NodeAssert.match(attached, /Treat it as the complete result/);
    NodeAssert.match(attached, /`rtk proxy <cmd>` only when its result is unusable/);
    // Per-command escape hatch stays available.
    NodeAssert.match(attached, /`RTK_DISABLED=1 <cmd>`/);
    // T3's session-only preface overrides the upstream persistent-setup copy.
    NodeAssert.match(attached, /Do not run `rtk init`/);
  });

  it("injects no RTK policy without an RTK attachment", () => {
    const detached = buildCodexDeveloperInstructions("default", runtime, true, false);

    NodeAssert.doesNotMatch(detached, /rtk/i);
  });
});
