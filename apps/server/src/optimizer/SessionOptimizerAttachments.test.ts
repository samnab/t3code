import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import {
  clearAllSessionOptimizerAttachments,
  clearSessionOptimizerAttachments,
  readSessionOptimizerAttachments,
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

    clearAllSessionOptimizerAttachments();
    expect(readSessionOptimizerAttachments(secondThread)).toBeUndefined();
  });
});
