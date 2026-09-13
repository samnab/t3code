import {
  type EnvironmentId,
  THREAD_GOAL_MAX_CHARS,
  type ThreadGoalLoop,
  type ThreadId,
} from "@t3tools/contracts";
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
 * Monotonic generation id for a freshly opened editor. Every open gets a
 * new epoch, so an async save completion (success, failure, or the close it
 * earns) can be recognized as stale after the editor was closed and reopened
 * — even on the same thread, where the thread key cannot tell them apart.
 */
let threadGoalEditorEpoch = 0;

export function nextThreadGoalEditorEpoch(): number {
  threadGoalEditorEpoch += 1;
  return threadGoalEditorEpoch;
}

/**
 * Pure state for the thread-goal editor shared by web and mobile. The state
 * carries the thread and generation (`epoch`) it was opened for, so a save
 * can never land on a thread the user has since navigated away from, a late
 * reply from a closed-and-reopened editor cannot clobber the fresh draft,
 * and a remote update (another device changed the goal while the editor was
 * open) never silently overwrites local edits: a clean editor follows the
 * remote value, a dirty one keeps the local draft and lets Save explicitly
 * win.
 */
export interface ThreadGoalEditorState {
  /** Generation of this open; stale-epoch completions are ignored. */
  readonly epoch: number;
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
      epoch: number;
      threadKey: string;
      environmentId: EnvironmentId;
      threadId: ThreadId;
      goal: string | null;
    }
  | { type: "close"; threadKey?: string; epoch?: number }
  | { type: "setDraft"; text: string }
  | { type: "remoteUpdate"; threadKey: string; goal: string | null }
  | { type: "beginSave" }
  | { type: "saveSuccess"; threadKey: string; goal: string | null; epoch: number }
  | { type: "saveFailure"; threadKey: string; error: string; epoch: number };

export function threadGoalEditorReducer(
  state: ThreadGoalEditorState | null,
  action: ThreadGoalEditorAction,
): ThreadGoalEditorState | null {
  switch (action.type) {
    case "open":
      return {
        epoch: action.epoch,
        threadKey: action.threadKey,
        environmentId: action.environmentId,
        threadId: action.threadId,
        savedGoal: action.goal,
        draft: action.goal ?? "",
        saving: false,
        error: null,
      };
    case "close":
      // A close can carry the thread and epoch it was issued for: the close
      // earned by a save RPC must not tear down an editor the user reopened
      // (a new epoch) or opened for another thread while the request was in
      // flight. A user-issued close carries neither and always wins.
      if (action.epoch !== undefined && state?.epoch !== action.epoch) return state;
      if (action.threadKey && state?.threadKey !== action.threadKey) return state;
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
      // The save RPC names its thread and generation: a late reply must never
      // mutate an editor reopened for another thread — or reopened on the
      // same thread, where only the epoch can tell the generations apart.
      if (!state || state.threadKey !== action.threadKey || state.epoch !== action.epoch) {
        return state;
      }
      return {
        ...state,
        saving: false,
        savedGoal: action.goal,
        draft: action.goal ?? "",
        error: null,
      };
    case "saveFailure":
      if (!state || state.threadKey !== action.threadKey || state.epoch !== action.epoch) {
        return state;
      }
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

/** Local feedback only. The server validates the objective again for preview and start. */
export function threadExperimentObjectiveError(objective: string): string | null {
  if (!hasVisibleThreadGoalText(objective)) {
    return "An experiment objective needs at least one visible character.";
  }
  if (objective.length > THREAD_GOAL_MAX_CHARS) {
    return `Keep it under ${THREAD_GOAL_MAX_CHARS} characters.`;
  }
  return null;
}

export type ThreadGoalLoopAction = "pause" | "resume" | "continue" | "reset";

/** Experiment terminal phases cannot be reopened through the ordinary loop budget controls. */
export function isThreadGoalLoopActionAvailable(
  loop: ThreadGoalLoop | null | undefined,
  action: ThreadGoalLoopAction,
): boolean {
  if (!loop) return false;
  if (loop.kind === "experiment") {
    const phase = loop.experiment?.phase;
    if (
      phase === undefined ||
      phase === "exhausted" ||
      phase === "failed" ||
      phase === "complete"
    ) {
      return false;
    }
  }
  switch (action) {
    case "pause":
      return loop.state === "idle" || loop.state === "running";
    case "resume":
      return loop.state === "paused" || loop.state === "blocked";
    case "continue":
      return loop.state === "capped";
    case "reset":
      return loop.state === "completed";
  }
}

/** Outcome of the stop/delete sequences: which step failed, or that both landed. */
export type ThreadGoalLifecycleOutcome =
  | "stopped"
  | "pause-failed"
  | "interrupt-failed"
  | "delete-failed";

/**
 * Stop sequencing for goal-driven work, shared by web and mobile: the loop
 * must be paused before the running turn is interrupted. Pausing alone lets
 * the current turn finish and only prevents the next continuation;
 * interrupting alone leaves the loop enabled, and the interrupted turn's
 * completion hands straight into a fresh continuation — the goal restarts
 * itself. Loops that cannot restart (already paused, capped, completed,
 * terminal experiments) skip the pause: pausing a completed loop would
 * revive it, and their interrupted turns start nothing anyway.
 */
export async function stopThreadGoalWork(input: {
  loop: ThreadGoalLoop | null;
  pauseGoalLoop: () => Promise<boolean>;
  interruptActiveTurn: () => Promise<boolean>;
}): Promise<ThreadGoalLifecycleOutcome> {
  if (isThreadGoalLoopActionAvailable(input.loop, "pause") && !(await input.pauseGoalLoop())) {
    return "pause-failed";
  }
  return (await input.interruptActiveTurn()) ? "stopped" : "interrupt-failed";
}

/**
 * Delete sequencing: pause first so no continuation can start while the
 * interrupt and the goal clear are in flight, then stop the current turn,
 * then clear the saved goal. An interrupt failure still clears — removing
 * the goal is the point of delete; the current turn merely finishes on its
 * own.
 */
export async function deleteThreadGoalWork(input: {
  loop: ThreadGoalLoop | null;
  pauseGoalLoop: () => Promise<boolean>;
  interruptActiveTurn: () => Promise<boolean>;
  clearGoal: () => Promise<boolean>;
}): Promise<ThreadGoalLifecycleOutcome> {
  if (isThreadGoalLoopActionAvailable(input.loop, "pause") && !(await input.pauseGoalLoop())) {
    return "pause-failed";
  }
  await input.interruptActiveTurn();
  return (await input.clearGoal()) ? "stopped" : "delete-failed";
}

/** Save is a no-op while saving, unchanged, or locally invalid. */
export function threadGoalEditorCanSave(state: ThreadGoalEditorState): boolean {
  return (
    !state.saving &&
    state.draft !== (state.savedGoal ?? "") &&
    threadGoalEditorDraftError(state.draft) === null
  );
}

/** The goal is visibly active only while its loop is driving work. */
export function isThreadGoalBeingPursued(input: {
  goal: string | null;
  loop: ThreadGoalLoop | null | undefined;
}): boolean {
  return input.goal !== null && input.loop?.state === "running";
}

export type ThreadGoalDisplay = "control" | "passive" | "none";

/**
 * Which goal display a composer surface should render. The editing control
 * (the pill that opens the editor) needs the composer's control row visible
 * and known server support; the durable goal text displays independently of
 * both, as a passive read-only fallback, so an unknown/reconnecting
 * capability or a collapsed/hidden control row never hides an existing
 * goal. Resolving to exactly one display keeps the goal from showing twice.
 */
export function resolveThreadGoalDisplay(input: {
  goal: string | null;
  /** Whether the control row that hosts the pill is visible right now. */
  controlsVisible: boolean;
  supportsThreadGoals: boolean;
}): ThreadGoalDisplay {
  if (input.controlsVisible && input.supportsThreadGoals) return "control";
  return input.goal !== null ? "passive" : "none";
}
