import { describe, expect, it } from "@effect/vitest";

import { applyRtkRewriteResult } from "./RtkRewrite.ts";

describe("applyRtkRewriteResult", () => {
  const toolInput = { command: "grep needle file", timeout: 120_000 };

  it("rewrites and auto-allows exit code 0 while preserving other tool input", () => {
    expect(
      applyRtkRewriteResult(toolInput, {
        code: 0,
        stdout: "rtk grep needle file\n",
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "RTK auto-rewrite",
        updatedInput: { command: "rtk grep needle file", timeout: 120_000 },
      },
    });
  });

  it("rewrites without auto-allowing exit code 3", () => {
    expect(
      applyRtkRewriteResult(toolInput, {
        code: 3,
        stdout: "rtk grep needle file\n",
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { command: "rtk grep needle file", timeout: 120_000 },
      },
    });
  });

  it.each([1, 2, 4])("passes through exit code %s", (code) => {
    expect(applyRtkRewriteResult(toolInput, { code, stdout: "ignored" })).toEqual({});
  });

  it("passes through identical and empty rewrites", () => {
    expect(applyRtkRewriteResult(toolInput, { code: 0, stdout: "grep needle file\n" })).toEqual({});
    expect(applyRtkRewriteResult(toolInput, { code: 0, stdout: "\n" })).toEqual({});
  });

  it("passes through non-command tool input", () => {
    expect(applyRtkRewriteResult({ path: "/repo" }, { code: 0, stdout: "rtk ls" })).toEqual({});
  });
});
