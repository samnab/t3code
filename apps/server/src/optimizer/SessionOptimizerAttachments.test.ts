import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import {
  buildCodexCbmAppServerArgs,
  clearAllSessionOptimizerAttachments,
  clearSessionOptimizerAttachments,
  isCurrentSessionOptimizerAttachments,
  readSessionOptimizerAttachments,
  removeSessionOptimizerAttachment,
  setSessionOptimizerAttachments,
} from "./SessionOptimizerAttachments.ts";

describe("SessionOptimizerAttachments", () => {
  it("keeps attachments isolated by thread and clears them reliably", () => {
    const firstThread = ThreadId.make("thread-first");
    const secondThread = ThreadId.make("thread-second");

    clearAllSessionOptimizerAttachments();
    setSessionOptimizerAttachments(firstThread, {
      projectId: ProjectId.make("project-first"),
      cwd: "/repo/first",
      configured: ["rtk", "cbm"],
      attached: ["rtk", "cbm"],
      ready: ["rtk", "cbm"],
      rtk: { command: "rtk" },
      cbm: {
        command: "/tools/codebase-memory-mcp",
        args: [],
        env: { CBM_ALLOWED_ROOT: "/repo/first" },
      },
    });
    setSessionOptimizerAttachments(secondThread, {
      projectId: ProjectId.make("project-second"),
      cwd: "/repo/second",
      configured: [],
      attached: [],
      ready: [],
    });

    expect(readSessionOptimizerAttachments(firstThread)).toMatchObject({
      projectId: "project-first",
      cwd: "/repo/first",
      attached: ["rtk", "cbm"],
    });
    expect(readSessionOptimizerAttachments(secondThread)?.attached).toEqual([]);

    clearSessionOptimizerAttachments(firstThread);
    expect(readSessionOptimizerAttachments(firstThread)).toBeUndefined();
    expect(readSessionOptimizerAttachments(secondThread)).toBeDefined();

    removeSessionOptimizerAttachment(secondThread, "cbm");
    expect(readSessionOptimizerAttachments(secondThread)).toMatchObject({
      configured: [],
      attached: [],
      ready: [],
    });

    clearAllSessionOptimizerAttachments();
    expect(readSessionOptimizerAttachments(secondThread)).toBeUndefined();
  });

  it("invalidates old session identities and removes unsupported attachments", () => {
    const threadId = ThreadId.make("thread-restarted");
    const first = {
      projectId: ProjectId.make("project-restarted"),
      cwd: "/repo/restarted",
      configured: ["rtk", "cbm"] as const,
      attached: ["rtk", "cbm"] as const,
      ready: ["rtk"] as const,
      rtk: { command: "rtk" as const },
      cbm: {
        command: "codebase-memory-mcp",
        args: [],
        env: { CBM_ALLOWED_ROOT: "/repo/restarted" },
      },
    };
    setSessionOptimizerAttachments(threadId, first);
    setSessionOptimizerAttachments(threadId, {
      ...first,
      attached: ["cbm"],
      ready: [],
    });

    expect(isCurrentSessionOptimizerAttachments(threadId, first)).toBe(false);
    removeSessionOptimizerAttachment(threadId, "cbm");
    expect(readSessionOptimizerAttachments(threadId)).toMatchObject({
      configured: ["rtk", "cbm"],
      attached: [],
      ready: [],
    });
    expect(readSessionOptimizerAttachments(threadId)).not.toHaveProperty("cbm");

    clearSessionOptimizerAttachments(threadId);
  });
});

describe("buildCodexCbmAppServerArgs", () => {
  it("scopes a single Codex MCP entry to the effective session cwd", () => {
    expect(
      buildCodexCbmAppServerArgs({
        command: "/tools/codebase-memory-mcp",
        args: ["serve"],
        env: { CBM_ALLOWED_ROOT: "/repo/space here" },
      }),
    ).toEqual([
      "-c",
      'mcp_servers.codebase-memory.command="/tools/codebase-memory-mcp"',
      "-c",
      'mcp_servers.codebase-memory.args=["serve"]',
      "-c",
      'mcp_servers.codebase-memory.env.CBM_ALLOWED_ROOT="/repo/space here"',
    ]);
  });
});
