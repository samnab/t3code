import { describe, expect, it } from "vite-plus/test";
import { ComposerContextId } from "@t3tools/contracts";

import { resolveComposerThreadGoalCommand } from "./thread-goal-command";

describe("resolveComposerThreadGoalCommand", () => {
  it("rejects a contextual /goal without persisting its context reference as goal text", () => {
    const submission = resolveComposerThreadGoalCommand({
      text: "/goal Ship it [#42](t3-context://v1/review-comment/pr-42)",
      attachmentCount: 0,
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("pr-42"),
            kind: "review-comment",
            label: "#42",
            sectionId: "pull-request:42",
            sectionTitle: "PR #42",
            filePath: "PR #42",
            startIndex: 0,
            endIndex: 0,
            rangeLabel: "Fix draft handling",
            text: "Pull request context",
            diff: "",
          },
        ],
      },
      capabilityKnown: true,
      supportsThreadGoals: true,
    });

    expect(submission).toEqual({
      command: { action: "set", goal: "Ship it" },
      blockReason: "context",
    });
  });
});
