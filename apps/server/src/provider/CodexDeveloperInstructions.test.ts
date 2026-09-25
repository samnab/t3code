import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";

describe("RTK Codex developer instructions", () => {
  const runtime = { model: "gpt-5.4", reasoningEffort: "high" };

  it("teaches the full RTK policy only for sessions that attached RTK", () => {
    const attached = buildCodexAdditionalContext(runtime, true, true).t3_code_rtk;

    NodeAssert.equal(attached?.kind, "application");
    NodeAssert.match(attached?.value ?? "", /<rtk_instructions>/);
    // Prefix supported commands, including every command in a chain.
    NodeAssert.match(attached?.value ?? "", /Prefix every shell command with `rtk`/);
    NodeAssert.match(attached?.value ?? "", /rtk git add \. && rtk git commit/);
    // Condensed output is the complete result; proxy only rescues unusable output.
    NodeAssert.match(attached?.value ?? "", /Treat it as the complete result/);
    NodeAssert.match(attached?.value ?? "", /`rtk proxy <cmd>` only when its result is unusable/);
    // Per-command escape hatch stays available.
    NodeAssert.match(attached?.value ?? "", /`RTK_DISABLED=1 <cmd>`/);
    // T3's session-only preface overrides the upstream persistent-setup copy.
    NodeAssert.match(attached?.value ?? "", /Do not run `rtk init`/);
  });

  it("injects no RTK policy without an RTK attachment", () => {
    const detached = buildCodexAdditionalContext(runtime, true, false);

    NodeAssert.equal(detached.t3_code_rtk, undefined);
  });
});
