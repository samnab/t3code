import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";

describe("RTK Codex developer instructions", () => {
  const runtime = { model: "gpt-6-sol", reasoningEffort: "high" };

  it("adds the RTK policy only when the session attached RTK", () => {
    const attached = buildCodexAdditionalContext(runtime, true, true).t3_code_rtk;

    NodeAssert.equal(attached?.kind, "application");
    NodeAssert.match(attached?.value ?? "", /<rtk_instructions>/);
    NodeAssert.match(attached?.value ?? "", /Prefix every shell command with `rtk`/);
    NodeAssert.match(attached?.value ?? "", /rtk git add \. && rtk git commit/);
    NodeAssert.match(attached?.value ?? "", /`rtk proxy <cmd>` only when its result is unusable/);
    NodeAssert.match(attached?.value ?? "", /`RTK_DISABLED=1 <cmd>`/);
    NodeAssert.match(attached?.value ?? "", /Do not run `rtk init`/);

    NodeAssert.equal(buildCodexAdditionalContext(runtime, true, false).t3_code_rtk, undefined);
  });
});
