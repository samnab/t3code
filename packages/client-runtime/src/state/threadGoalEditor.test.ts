import {
  ComposerContextId,
  EnvironmentId,
  ThreadId,
  type ThreadGoalLoop,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deleteThreadGoalWork,
  isThreadGoalLoopActionAvailable,
  parseThreadGoalCommand,
  readThreadGoalState,
  readThreadVoiceNotifications,
  resolveComposerThreadGoalCommand,
  runThreadGoalMutation,
  stopThreadGoalWork,
  threadGoalEditorCanSave,
  threadGoalEditorDraftError,
  threadGoalEditorReducer,
  type ThreadGoalEditorState,
} from "./threadGoalEditor.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadKey = "environment-1:thread-1";

function openState(goal: string | null, epoch = 1): ThreadGoalEditorState {
  const state = threadGoalEditorReducer(null, {
    type: "open",
    epoch,
    threadKey,
    environmentId,
    threadId,
    goal,
  });
  if (state === null) throw new Error("open must create editor state");
  return state;
}

function loop(state: ThreadGoalLoop["state"]): ThreadGoalLoop {
  return {
    state,
    mode: "t3",
    iterations: 1,
    maxIterations: 10,
    reason: null,
    updatedAt: DateTime.makeUnsafe("2026-09-07T04:00:00.000Z"),
  };
}

describe("thread goal composer commands", () => {
  it("parses show, clear, and set without intercepting ordinary prompts", () => {
    expect(parseThreadGoalCommand(" /GOAL ")).toEqual({ action: "show" });
    expect(parseThreadGoalCommand("/goal clear")).toEqual({ action: "clear" });
    expect(parseThreadGoalCommand("/goal  Ship the fix\nnow ")).toEqual({
      action: "set",
      goal: "Ship the fix\nnow",
    });
    expect(parseThreadGoalCommand("please run /goal")).toBeNull();
  });

  it("strips composer context labels before parsing and reports blocking context", () => {
    const result = resolveComposerThreadGoalCommand({
      text: "/goal Review [terminal output](t3-context://v1/terminal/context-1)",
      isServerThread: true,
      attachmentCount: 0,
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("context-1"),
            kind: "terminal",
            label: "terminal output",
            terminalId: "terminal-1",
            terminalLabel: "Terminal",
            lineStart: 1,
            lineEnd: 1,
            text: "output",
          },
        ],
      },
      capabilityKnown: true,
      supportsThreadGoals: true,
    });

    expect(result).toEqual({
      command: { action: "set", goal: "Review" },
      blockReason: "context",
    });
  });
});

describe("thread goal metadata", () => {
  it("reads projection and legacy shell defaults without v1 state", () => {
    const goalLoop = loop("paused");
    expect(readThreadGoalState({ goal: "Ship it", goalLoop })).toEqual({
      goal: "Ship it",
      goalLoop,
    });
    expect(readThreadGoalState({})).toEqual({ goal: null, goalLoop: null });
    expect(readThreadVoiceNotifications({ voiceNotifications: false })).toBe(false);
    expect(readThreadVoiceNotifications({})).toBe(true);
  });
});

describe("thread goal editor", () => {
  it("follows remote updates only while the editor is clean", () => {
    const clean = openState("old goal");
    const synced = threadGoalEditorReducer(clean, {
      type: "remoteUpdate",
      threadKey,
      goal: "remote goal",
    });
    expect(synced?.draft).toBe("remote goal");

    const dirty = threadGoalEditorReducer(
      { ...clean, draft: "my edit" },
      { type: "remoteUpdate", threadKey, goal: "remote goal" },
    );
    expect(dirty?.draft).toBe("my edit");
    expect(dirty?.savedGoal).toBe("remote goal");
  });

  it("ignores stale save replies after the editor is reopened", () => {
    const edited = { ...openState("old goal", 2), draft: "fresh draft" };
    expect(
      threadGoalEditorReducer(edited, {
        type: "saveSuccess",
        threadKey,
        goal: "stale goal",
        epoch: 1,
      }),
    ).toBe(edited);
    expect(threadGoalEditorReducer(edited, { type: "close", threadKey, epoch: 1 })).toBe(edited);
  });

  it("validates visible text, length, change, and in-flight state", () => {
    expect(threadGoalEditorDraftError(" \u200b\ufeff\u2060\n")).toContain("visible character");
    expect(threadGoalEditorDraftError("x".repeat(1_025))).toContain("1024");
    expect(threadGoalEditorCanSave(openState("goal"))).toBe(false);
    expect(threadGoalEditorCanSave({ ...openState(null), draft: "new goal" })).toBe(true);
    expect(threadGoalEditorCanSave({ ...openState(null), draft: "new goal", saving: true })).toBe(
      false,
    );
  });
});

describe("thread goal loop controls", () => {
  it("offers only actions valid for the current loop state", () => {
    expect(isThreadGoalLoopActionAvailable(loop("running"), "pause")).toBe(true);
    expect(isThreadGoalLoopActionAvailable(loop("paused"), "resume")).toBe(true);
    expect(isThreadGoalLoopActionAvailable(loop("capped"), "continue")).toBe(true);
    expect(isThreadGoalLoopActionAvailable(loop("completed"), "reset")).toBe(true);
    expect(isThreadGoalLoopActionAvailable(loop("running"), "reset")).toBe(false);
  });

  it("pauses before interrupting, and clears even when delete cannot interrupt", async () => {
    const stopCalls: string[] = [];
    expect(
      await stopThreadGoalWork({
        loop: loop("running"),
        pauseGoalLoop: async () => {
          stopCalls.push("pause");
          return true;
        },
        interruptActiveTurn: async () => {
          stopCalls.push("interrupt");
          return true;
        },
      }),
    ).toBe("stopped");
    expect(stopCalls).toEqual(["pause", "interrupt"]);

    const deleteCalls: string[] = [];
    expect(
      await deleteThreadGoalWork({
        loop: loop("paused"),
        pauseGoalLoop: async () => true,
        interruptActiveTurn: async () => {
          deleteCalls.push("interrupt");
          return false;
        },
        clearGoal: async () => {
          deleteCalls.push("clear");
          return true;
        },
      }),
    ).toBe("stopped");
    expect(deleteCalls).toEqual(["interrupt", "clear"]);
  });

  it("serializes mutations for the same thread", async () => {
    let releaseFirst: (() => void) | undefined;
    const first = runThreadGoalMutation(
      { environmentId, threadId },
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("saved");
        }),
    );

    await Promise.resolve();
    await expect(
      runThreadGoalMutation({ environmentId, threadId }, async () => "later"),
    ).resolves.toEqual({ status: "busy" });
    releaseFirst?.();
    await expect(first).resolves.toEqual({ status: "completed", value: "saved" });
  });
});
