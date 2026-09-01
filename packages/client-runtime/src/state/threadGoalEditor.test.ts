import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextThreadGoalEditorEpoch,
  resolveThreadGoalCommandBlockReason,
  resolveThreadGoalDisplay,
  threadGoalEditorCanSave,
  threadGoalEditorDraftError,
  threadGoalEditorReducer,
  type ThreadGoalEditorState,
} from "./threadGoalEditor.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadKey = "environment-1:thread-1";

function openState(
  goal: string | null,
  epoch: number = nextThreadGoalEditorEpoch(),
): ThreadGoalEditorState {
  return threadGoalEditorReducer(null, {
    type: "open",
    epoch,
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
      epoch: nextThreadGoalEditorEpoch(),
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
      threadKey,
      error: "socket closed",
      epoch: state.epoch,
    })!;
    expect(failed.saving).toBe(false);
    expect(failed.error).toBe("socket closed");
    expect(failed.draft).toBe("edited during save");
  });

  it("resets to the saved value on success and closes cleanly", () => {
    let state = openState("goal");
    state = threadGoalEditorReducer(state, { type: "setDraft", text: "new goal" })!;
    state = threadGoalEditorReducer(state, { type: "beginSave" })!;
    state = threadGoalEditorReducer(state, {
      type: "saveSuccess",
      threadKey,
      goal: "new goal",
      epoch: state.epoch,
    })!;
    expect(state).toMatchObject({ draft: "new goal", savedGoal: "new goal", saving: false });
    expect(threadGoalEditorReducer(state, { type: "close" })).toBeNull();
  });

  it("a late save reply for thread A never mutates thread B's editor", () => {
    // Save on A, navigate away (effect closes the stale editor), open B.
    // Both opens share an epoch so only the thread key guard can reject A's
    // late reply — the thread-switch guard holds independently of epochs.
    let state = openState("goal A", 101);
    state = threadGoalEditorReducer(state, { type: "beginSave" })!;
    state = threadGoalEditorReducer(state, { type: "close" }) as ThreadGoalEditorState;
    const threadBKey = "environment-1:thread-2";
    state = threadGoalEditorReducer(state, {
      type: "open",
      epoch: 101,
      threadKey: threadBKey,
      environmentId,
      threadId: ThreadId.make("thread-2"),
      goal: "goal B",
    })!;

    const staleSuccess = threadGoalEditorReducer(state, {
      type: "saveSuccess",
      threadKey,
      goal: "goal A saved",
      epoch: 101,
    })!;
    expect(staleSuccess).toBe(state);

    const staleFailure = threadGoalEditorReducer(staleSuccess, {
      type: "saveFailure",
      threadKey,
      error: "socket closed",
      epoch: 101,
    })!;
    expect(staleFailure).toBe(state);

    // The completion-driven close is guarded the same way: B stays open.
    expect(threadGoalEditorReducer(staleFailure, { type: "close", threadKey })).toBe(state);

    // B's own replies still apply, and an unguarded close still closes.
    const applied = threadGoalEditorReducer(state, {
      type: "saveSuccess",
      threadKey: threadBKey,
      goal: "goal B saved",
      epoch: 101,
    })!;
    expect(applied).toMatchObject({ savedGoal: "goal B saved", draft: "goal B saved" });
    expect(threadGoalEditorReducer(applied, { type: "close", threadKey: threadBKey })).toBeNull();
  });

  it("ignores a stale save reply after close/reopen on the same thread", () => {
    // Generation 1 starts a save; the user closes and reopens the editor on
    // the same thread (epoch 2) and types a fresh draft. The late reply from
    // generation 1 must not clobber it — here the thread key matches, so only
    // the epoch guard can tell the generations apart.
    const first = threadGoalEditorReducer(openState("old goal", 1), { type: "beginSave" })!;
    expect(first.epoch).toBe(1);
    const reopened = openState("old goal", 2);
    const edited = threadGoalEditorReducer(reopened, { type: "setDraft", text: "fresh draft" })!;

    const staleSuccess = threadGoalEditorReducer(edited, {
      type: "saveSuccess",
      threadKey,
      goal: "stale goal",
      epoch: 1,
    })!;
    expect(staleSuccess).toBe(edited);

    const staleFailure = threadGoalEditorReducer(edited, {
      type: "saveFailure",
      threadKey,
      error: "socket closed",
      epoch: 1,
    })!;
    expect(staleFailure).toBe(edited);

    // The close earned by the stale save must not close the reopened editor.
    expect(threadGoalEditorReducer(edited, { type: "close", threadKey, epoch: 1 })).toBe(edited);

    // The current generation's own save still applies and closes.
    let state = threadGoalEditorReducer(edited, { type: "beginSave" })!;
    state = threadGoalEditorReducer(state, {
      type: "saveSuccess",
      threadKey,
      goal: "fresh draft",
      epoch: 2,
    })!;
    expect(state).toMatchObject({
      savedGoal: "fresh draft",
      draft: "fresh draft",
      saving: false,
      epoch: 2,
    });
    expect(threadGoalEditorReducer(state, { type: "close", threadKey, epoch: 2 })).toBeNull();
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

describe("resolveThreadGoalDisplay", () => {
  it("shows the editing control only with visible controls and known support", () => {
    expect(
      resolveThreadGoalDisplay({ goal: null, controlsVisible: true, supportsThreadGoals: true }),
    ).toBe("control");
    expect(
      resolveThreadGoalDisplay({
        goal: "ship it",
        controlsVisible: true,
        supportsThreadGoals: true,
      }),
    ).toBe("control");
  });

  it("keeps an existing goal readable while capability is unknown or unsupported", () => {
    // Unknown (config not loaded / reconnecting) and known-unsupported both
    // hide the control but never the durable goal text.
    expect(
      resolveThreadGoalDisplay({
        goal: "ship it",
        controlsVisible: true,
        supportsThreadGoals: false,
      }),
    ).toBe("passive");
  });

  it("falls back passively when controls are collapsed or hidden", () => {
    expect(
      resolveThreadGoalDisplay({
        goal: "ship it",
        controlsVisible: false,
        supportsThreadGoals: true,
      }),
    ).toBe("passive");
  });

  it("renders nothing without a goal or any way to display one", () => {
    expect(
      resolveThreadGoalDisplay({ goal: null, controlsVisible: false, supportsThreadGoals: true }),
    ).toBe("none");
    expect(
      resolveThreadGoalDisplay({ goal: null, controlsVisible: true, supportsThreadGoals: false }),
    ).toBe("none");
  });
});
