import { ComposerContextId } from "@t3tools/contracts";
import { resolveComposerThreadGoalCommand } from "@t3tools/client-runtime/state/thread-goal-editor";
import { describe, expect, it } from "vite-plus/test";

describe("mobile /goal command", () => {
  it("removes rendered context labels and refuses to send contextual goals as turns", () => {
    expect(
      resolveComposerThreadGoalCommand({
        text: "/goal Ship it [#42](t3-context://v1/review-comment/pr-42)",
        isServerThread: true,
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
      }),
    ).toEqual({ command: { action: "set", goal: "Ship it" }, blockReason: "context" });
  });

  it("blocks the command while a draft thread is still being created", () => {
    expect(
      resolveComposerThreadGoalCommand({
        text: "/goal ship",
        isServerThread: false,
        attachmentCount: 0,
        capabilityKnown: true,
        supportsThreadGoals: true,
      }),
    ).toEqual({ command: { action: "set", goal: "ship" }, blockReason: "draft-thread" });
  });
});
