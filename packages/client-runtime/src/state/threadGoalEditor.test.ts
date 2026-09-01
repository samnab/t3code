import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadGoalCommandBlockReason,
  threadGoalEditorCanSave,
  threadGoalEditorDraftError,
  threadGoalEditorReducer,
  type ThreadGoalEditorState,
} from "./threadGoalEditor.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadKey = "environment-1:thread-1";

function openState(goal: string | null): ThreadGoalEditorState {
  return threadGoalEditorReducer(null, {
    type: "open",
    threadKey,
    environmentId,
    threadId,
    goal,
  })!;
}

describe("resolveThreadGoalCommandBlockReason", () => {
  const base = {
    isServerThread: true,
    attachmentCount: 0,
    contextCount: 0,
    capabilityKnown: true,
    supportsThreadGoals: true,
  };

  it("allows a plain supported server thread", () => {
    expect(resolveThreadGoalCommandBlockReason(base)).toBeNull();
  });

  it("blocks drafts, attachments, and context first", () => {
    expect(resolveThreadGoalCommandBlockReason({ ...base, isServerThread: false })).toBe(
      "draft-thread",
    );
    expect(resolveThreadGoalCommandBlockReason({ ...base, attachmentCount: 1 })).toBe(
      "attachments",
    );
    expect(resolveThreadGoalCommandBlockReason({ ...base, contextCount: 2 })).toBe("context");
  });

  it("separates unknown capability from known-unsupported", () => {
    expect(resolveThreadGoalCommandBlockReason({ ...base, capabilityKnown: false })).toBe(
      "unavailable",
    );
    expect(
      resolveThreadGoalCommandBlockReason({
        ...base,
        capabilityKnown: false,
        supportsThreadGoals: false,
      }),
    ).toBe("unavailable");
    expect(resolveThreadGoalCommandBlockReason({ ...base, supportsThreadGoals: false })).toBe(
      "unsupported",
    );
  });
});

describe("threadGoalEditorReducer", () => {
  it("opens prefilled for the requesting thread only", () => {
    const state = openState("ship it");
    expect(state).toMatchObject({ threadKey, draft: "ship it", savedGoal: "ship it" });
    // A second open for another thread rebinds the editor completely.
    const other = threadGoalEditorReducer(state, {
      type: "open",
      threadKey: "environment-1:thread-2",
      environmentId,
      threadId: ThreadId.make("thread-2"),
      goal: null,
    })!;
    expect(other).toMatchObject({ threadKey: "environment-1:thread-2", draft: "" });
  });

  it("follows remote updates only while clean", () => {
    const clean = openState("old goal");
    const synced = threadGoalEditorReducer(clean, {
      type: "remoteUpdate",
      threadKey,
      goal: "remote goal",
    })!;
    expect(synced.draft).toBe("remote goal");

    const dirty = threadGoalEditorReducer(
      { ...clean, draft: "my edit" },
      { type: "remoteUpdate", threadKey, goal: "remote goal" },
    )!;
    expect(dirty.draft).toBe("my edit");
    expect(dirty.savedGoal).toBe("remote goal");
  });

  it("ignores remote updates for other threads", () => {
    const state = openState("old goal");
    expect(
      threadGoalEditorReducer(state, {
        type: "remoteUpdate",
        threadKey: "environment-1:thread-2",
        goal: "remote goal",
      }),
    ).toBe(state);
  });

  it("guards double saves and keeps draft on failure", () => {
    let state = openState("goal");
    state = threadGoalEditorReducer(state, { type: "beginSave" })!;
    const saving = state;
    expect(threadGoalEditorReducer(state, { type: "beginSave" })).toBe(saving);

    state = threadGoalEditorReducer(state, {
      type: "setDraft",
      text: "edited during save",
    }) as ThreadGoalEditorState;
    expect(state.draft).toBe("edited during save");

    const failed = threadGoalEditorReducer(state, {
      type: "saveFailure",
      error: "socket closed",
    })!;
    expect(failed.saving).toBe(false);
    expect(failed.error).toBe("socket closed");
    expect(failed.draft).toBe("edited during save");
  });

  it("resets to the saved value on success and closes cleanly", () => {
    let state = openState("goal");
    state = threadGoalEditorReducer(state, { type: "setDraft", text: "new goal" })!;
    state = threadGoalEditorReducer(state, { type: "beginSave" })!;
    state = threadGoalEditorReducer(state, { type: "saveSuccess", goal: "new goal" })!;
    expect(state).toMatchObject({ draft: "new goal", savedGoal: "new goal", saving: false });
    expect(threadGoalEditorReducer(state, { type: "close" })).toBeNull();
  });

  it("treats an unchanged or invalid draft as a save no-op", () => {
    expect(threadGoalEditorCanSave(openState("goal"))).toBe(false);
    expect(threadGoalEditorCanSave({ ...openState(null), draft: " \u200b" })).toBe(false);
    expect(threadGoalEditorCanSave({ ...openState(null), draft: "x".repeat(1025) })).toBe(false);
    expect(threadGoalEditorCanSave({ ...openState(null), draft: "new goal" })).toBe(true);
    expect(threadGoalEditorCanSave({ ...openState(null), draft: "new goal", saving: true })).toBe(
      false,
    );
  });

  it("validates visible text and length locally", () => {
    expect(threadGoalEditorDraftError(" \u200b\ufeff\u2060\n")).toContain("visible character");
    expect(threadGoalEditorDraftError("x".repeat(1025))).toContain("1024");
    expect(threadGoalEditorDraftError("résumé 🚀")).toBeNull();
    expect(threadGoalEditorDraftError("x".repeat(1024))).toBeNull();
  });
});
