import { describe, expect, it } from "@effect/vitest";

import {
  applyRtkRewriteResult,
  isSupportedRtkVersion,
  runRtkPreToolUseHook,
} from "./RtkRewrite.ts";

describe("applyRtkRewriteResult", () => {
  const toolInput = { command: "grep needle file", timeout: 120_000 };

  it.each([0, 3])(
    "rewrites exit code %s without bypassing Claude permission evaluation",
    (code) => {
      expect(
        applyRtkRewriteResult(toolInput, {
          code,
          stdout: "rtk grep needle file\n",
        }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: { command: "rtk grep needle file", timeout: 120_000 },
        },
      });
    },
  );

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

describe("isSupportedRtkVersion", () => {
  it.each(["0.23.0", "0.23.1-beta.1", "0.40.0", "1.0.0"])("accepts %s", (version) => {
    expect(isSupportedRtkVersion(version)).toBe(true);
  });

  it.each([null, "0.22.9", "0.23.0-beta.1", "unknown"])("rejects %s", (version) => {
    expect(isSupportedRtkVersion(version)).toBe(false);
  });
});

describe("runRtkPreToolUseHook", () => {
  const input = {
    hook_event_name: "PreToolUse" as const,
    tool_name: "Bash",
    tool_input: { command: "git status", description: "Inspect worktree" },
    tool_use_id: "tool-1",
    session_id: "session-1",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/repo",
  };

  it("fails open when the RTK child cannot run", async () => {
    await expect(
      runRtkPreToolUseHook(input, () => Promise.reject(new Error("rtk missing"))),
    ).resolves.toEqual({});
  });

  it("does not call RTK for another tool", async () => {
    let called = false;
    await expect(
      runRtkPreToolUseHook({ ...input, tool_name: "Read" }, () => {
        called = true;
        return Promise.resolve({ code: 0, stdout: "rtk read" });
      }),
    ).resolves.toEqual({});
    expect(called).toBe(false);
  });
});
