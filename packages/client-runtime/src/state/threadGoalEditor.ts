import { type EnvironmentId, THREAD_GOAL_MAX_CHARS, type ThreadId } from "@t3tools/contracts";
import { hasVisibleThreadGoalText } from "@t3tools/shared/composerTrigger";

export type ThreadGoalCommandBlockReason =
  | "draft-thread"
  | "attachments"
  | "context"
  | "unavailable"
  | "unsupported";

/**
 * Why a typed `/goal` command cannot run right now, or null when it can.
 * `capabilityKnown` false means the server config (and its capabilities) has
 * not loaded yet — distinct from a known-unsupported server, so loading and
 * disconnected states can say something truthful instead of "update server".
 */
export function resolveThreadGoalCommandBlockReason(input: {
  isServerThread: boolean;
  attachmentCount: number;
  contextCount: number;
  capabilityKnown: boolean;
  supportsThreadGoals: boolean;
}): ThreadGoalCommandBlockReason | null {
  if (!input.isServerThread) return "draft-thread";
  if (input.attachmentCount > 0) return "attachments";
  if (input.contextCount > 0) return "context";
  if (!input.capabilityKnown) return "unavailable";
  if (!input.supportsThreadGoals) return "unsupported";
  return null;
}

/**
 * Pure state for the thread-goal editor shared by web and mobile. The state
 * carries the thread it was opened for, so a save can never land on a thread
 * the user has since navigated away from, and a remote update (another device
 * changed the goal while the editor was open) never silently overwrites local
 * edits: a clean editor follows the remote value, a dirty one keeps the local
 * draft and lets Save explicitly win.
 */
export interface ThreadGoalEditorState {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Last known persisted goal for the thread. */
  readonly savedGoal: string | null;
  readonly draft: string;
  readonly saving: boolean;
  readonly error: string | null;
}

export type ThreadGoalEditorAction =
  | {
      type: "open";
      threadKey: string;
      environmentId: EnvironmentId;
      threadId: ThreadId;
      goal: string | null;
    }
  | { type: "close" }
  | { type: "setDraft"; text: string }
  | { type: "remoteUpdate"; threadKey: string; goal: string | null }
  | { type: "beginSave" }
  | { type: "saveSuccess"; goal: string | null }
  | { type: "saveFailure"; error: string };

export function threadGoalEditorReducer(
  state: ThreadGoalEditorState | null,
  action: ThreadGoalEditorAction,
): ThreadGoalEditorState | null {
  switch (action.type) {
    case "open":
      return {
        threadKey: action.threadKey,
        environmentId: action.environmentId,
        threadId: action.threadId,
        savedGoal: action.goal,
        draft: action.goal ?? "",
        saving: false,
        error: null,
      };
    case "close":
      return null;
    case "setDraft":
      if (!state || state.draft === action.text) return state;
      return { ...state, draft: action.text, error: null };
    case "remoteUpdate": {
      if (!state || state.threadKey !== action.threadKey || state.savedGoal === action.goal) {
        return state;
      }
      const dirty = state.draft !== (state.savedGoal ?? "");
      return { ...state, savedGoal: action.goal, ...(dirty ? {} : { draft: action.goal ?? "" }) };
    }
    // A second save while one is in flight (rapid Enter) must not start
    // another metadata write or it could reorder a set against a clear.
    case "beginSave":
      if (!state || state.saving) return state;
      return { ...state, saving: true, error: null };
    case "saveSuccess":
      if (!state) return state;
      return {
        ...state,
        saving: false,
        savedGoal: action.goal,
        draft: action.goal ?? "",
        error: null,
      };
    case "saveFailure":
      if (!state) return state;
      return { ...state, saving: false, error: action.error };
  }
}

/** Local validation before any metadata RPC: visible text within the cap. */
export function threadGoalEditorDraftError(draft: string): string | null {
  if (!hasVisibleThreadGoalText(draft)) {
    return "A goal needs at least one visible character.";
  }
  if (draft.length > THREAD_GOAL_MAX_CHARS) {
    return `Keep it under ${THREAD_GOAL_MAX_CHARS} characters.`;
  }
  return null;
}

/** Save is a no-op while saving, unchanged, or locally invalid. */
export function threadGoalEditorCanSave(state: ThreadGoalEditorState): boolean {
  return (
    !state.saving &&
    state.draft !== (state.savedGoal ?? "") &&
    threadGoalEditorDraftError(state.draft) === null
  );
}
