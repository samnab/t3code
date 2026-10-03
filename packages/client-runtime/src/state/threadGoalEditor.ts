import {
  type EnvironmentId,
  THREAD_GOAL_MAX_CHARS,
  type OrchestrationMessageContext,
  type ScopedThreadRef,
  type ThreadGoal,
  type ThreadGoalLoop,
  type ThreadId,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import { scopedThreadKey } from "../environment/scoped.ts";

export interface ThreadGoalState {
  readonly goal: ThreadGoal | null;
  readonly goalLoop: ThreadGoalLoop | null;
}

/** Reads goal metadata from either a full v2 thread projection or a shell row. */
export function readThreadGoalState(thread: {
  readonly goal?: ThreadGoal | null;
  readonly goalLoop?: ThreadGoalLoop | null;
}): ThreadGoalState {
  return { goal: thread.goal ?? null, goalLoop: thread.goalLoop ?? null };
}

/** Older v2 snapshots predate the field and preserve the enabled default. */
export function readThreadVoiceNotifications(thread: {
  readonly voiceNotifications?: boolean;
}): boolean {
  return thread.voiceNotifications ?? true;
}

export type ThreadGoalCommand =
  | { readonly action: "show" }
  | { readonly action: "clear" }
  | { readonly action: "set"; readonly goal: string };

const THREAD_GOAL_SEPARATOR = "\\p{White_Space}";
const THREAD_GOAL_COMMAND_REGEX = new RegExp(
  `^/goal(?:${THREAD_GOAL_SEPARATOR}+([\\s\\S]*))?$`,
  "iu",
);
const THREAD_GOAL_LEADING_WHITESPACE = new RegExp(`^${THREAD_GOAL_SEPARATOR}+`, "u");
const THREAD_GOAL_TRAILING_WHITESPACE = new RegExp(`${THREAD_GOAL_SEPARATOR}+$`, "u");
const INVISIBLE_THREAD_GOAL_CHARS = /^[\p{White_Space}\u200B\uFEFF\u2060]*$/u;

function trimThreadGoalWhitespace(text: string): string {
  return text
    .replace(THREAD_GOAL_LEADING_WHITESPACE, "")
    .replace(THREAD_GOAL_TRAILING_WHITESPACE, "");
}

export function hasVisibleThreadGoalText(text: string): boolean {
  return !INVISIBLE_THREAD_GOAL_CHARS.test(text);
}

/** Recognizes the provider-neutral `/goal`, `/goal clear`, and `/goal <text>` commands. */
export function parseThreadGoalCommand(text: string): ThreadGoalCommand | null {
  const match = THREAD_GOAL_COMMAND_REGEX.exec(trimThreadGoalWhitespace(text));
  if (match === null) return null;
  const goal = trimThreadGoalWhitespace(match[1] ?? "");
  if (goal === "") return { action: "show" };
  if (/^clear$/i.test(goal)) return { action: "clear" };
  return { action: "set", goal };
}

export type ThreadGoalCommandBlockReason =
  | "draft-thread"
  | "attachments"
  | "context"
  | "unavailable"
  | "unsupported";

export function resolveThreadGoalCommandBlockReason(input: {
  readonly isServerThread: boolean;
  readonly attachmentCount: number;
  readonly contextCount: number;
  readonly capabilityKnown: boolean;
  readonly supportsThreadGoals: boolean;
}): ThreadGoalCommandBlockReason | null {
  if (!input.isServerThread) return "draft-thread";
  if (input.attachmentCount > 0) return "attachments";
  if (input.contextCount > 0) return "context";
  if (!input.capabilityKnown) return "unavailable";
  if (!input.supportsThreadGoals) return "unsupported";
  return null;
}

/** Parses a composer `/goal` submission without persisting rendered context labels as goal text. */
export function resolveComposerThreadGoalCommand(input: {
  readonly text: string;
  readonly isServerThread: boolean;
  readonly attachmentCount: number;
  readonly context?: OrchestrationMessageContext;
  readonly capabilityKnown: boolean;
  readonly supportsThreadGoals: boolean;
}): {
  readonly command: ThreadGoalCommand;
  readonly blockReason: ThreadGoalCommandBlockReason | null;
} | null {
  const command = parseThreadGoalCommand(replaceComposerContextReferences(input.text, () => ""));
  if (command === null) return null;
  return {
    command,
    blockReason: resolveThreadGoalCommandBlockReason({
      isServerThread: input.isServerThread,
      attachmentCount: input.attachmentCount,
      contextCount: input.context?.records.length ?? 0,
      capabilityKnown: input.capabilityKnown,
      supportsThreadGoals: input.supportsThreadGoals,
    }),
  };
}

let threadGoalEditorEpoch = 0;

export function nextThreadGoalEditorEpoch(): number {
  threadGoalEditorEpoch += 1;
  return threadGoalEditorEpoch;
}

export interface ThreadGoalEditorState {
  readonly epoch: number;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly savedGoal: string | null;
  readonly draft: string;
  readonly saving: boolean;
  readonly error: string | null;
}

export type ThreadGoalEditorAction =
  | {
      readonly type: "open";
      readonly epoch: number;
      readonly threadKey: string;
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly goal: string | null;
    }
  | { readonly type: "close"; readonly threadKey?: string; readonly epoch?: number }
  | { readonly type: "setDraft"; readonly text: string }
  | { readonly type: "remoteUpdate"; readonly threadKey: string; readonly goal: string | null }
  | { readonly type: "beginSave" }
  | {
      readonly type: "saveSuccess";
      readonly threadKey: string;
      readonly goal: string | null;
      readonly epoch: number;
    }
  | {
      readonly type: "saveFailure";
      readonly threadKey: string;
      readonly error: string;
      readonly epoch: number;
    };

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
      if (action.epoch !== undefined && state?.epoch !== action.epoch) return state;
      if (action.threadKey !== undefined && state?.threadKey !== action.threadKey) return state;
      return null;
    case "setDraft":
      return state === null || state.draft === action.text
        ? state
        : { ...state, draft: action.text, error: null };
    case "remoteUpdate": {
      if (
        state === null ||
        state.threadKey !== action.threadKey ||
        state.savedGoal === action.goal
      ) {
        return state;
      }
      const dirty = state.draft !== (state.savedGoal ?? "");
      return { ...state, savedGoal: action.goal, ...(dirty ? {} : { draft: action.goal ?? "" }) };
    }
    case "beginSave":
      return state === null || state.saving ? state : { ...state, saving: true, error: null };
    case "saveSuccess":
      if (state === null || state.threadKey !== action.threadKey || state.epoch !== action.epoch) {
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
      if (state === null || state.threadKey !== action.threadKey || state.epoch !== action.epoch) {
        return state;
      }
      return { ...state, saving: false, error: action.error };
  }
}

export function threadGoalEditorDraftError(draft: string): string | null {
  if (!hasVisibleThreadGoalText(draft)) {
    return "A goal needs at least one visible character.";
  }
  if (draft.length > THREAD_GOAL_MAX_CHARS) {
    return `Keep it under ${THREAD_GOAL_MAX_CHARS} characters.`;
  }
  return null;
}

export function threadGoalEditorCanSave(state: ThreadGoalEditorState): boolean {
  return (
    !state.saving &&
    state.draft !== (state.savedGoal ?? "") &&
    threadGoalEditorDraftError(state.draft) === null
  );
}

export type ThreadGoalLoopAction = "pause" | "resume" | "continue" | "reset";

export function isThreadGoalLoopActionAvailable(
  loop: ThreadGoalLoop | null | undefined,
  action: ThreadGoalLoopAction,
): boolean {
  if (loop === null || loop === undefined) return false;
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

export function isThreadGoalBeingPursued(input: {
  readonly goal: string | null;
  readonly loop: ThreadGoalLoop | null | undefined;
}): boolean {
  return input.goal !== null && input.loop?.state === "running";
}

export type ThreadGoalDisplay = "control" | "passive" | "none";

export function resolveThreadGoalDisplay(input: {
  readonly goal: string | null;
  readonly controlsVisible: boolean;
  readonly supportsThreadGoals: boolean;
}): ThreadGoalDisplay {
  if (input.controlsVisible && input.supportsThreadGoals) return "control";
  return input.goal !== null ? "passive" : "none";
}

export type ThreadGoalLifecycleOutcome =
  | "stopped"
  | "pause-failed"
  | "interrupt-failed"
  | "delete-failed";

export async function stopThreadGoalWork(input: {
  readonly loop: ThreadGoalLoop | null;
  readonly pauseGoalLoop: () => Promise<boolean>;
  readonly interruptActiveTurn: () => Promise<boolean>;
}): Promise<ThreadGoalLifecycleOutcome> {
  if (isThreadGoalLoopActionAvailable(input.loop, "pause") && !(await input.pauseGoalLoop())) {
    return "pause-failed";
  }
  return (await input.interruptActiveTurn()) ? "stopped" : "interrupt-failed";
}

export async function deleteThreadGoalWork(input: {
  readonly loop: ThreadGoalLoop | null;
  readonly pauseGoalLoop: () => Promise<boolean>;
  readonly interruptActiveTurn: () => Promise<boolean>;
  readonly clearGoal: () => Promise<boolean>;
}): Promise<ThreadGoalLifecycleOutcome> {
  if (isThreadGoalLoopActionAvailable(input.loop, "pause") && !(await input.pauseGoalLoop())) {
    return "pause-failed";
  }
  await input.interruptActiveTurn();
  return (await input.clearGoal()) ? "stopped" : "delete-failed";
}

const activeThreadGoalMutations = new Set<string>();

export type ThreadGoalMutationResult<T> =
  | { readonly status: "busy" }
  | { readonly status: "completed"; readonly value: T };

/** Runs one goal mutation per thread, including any pause or interrupt that precedes the write. */
export async function runThreadGoalMutation<T>(
  threadRef: ScopedThreadRef,
  mutation: () => Promise<T>,
): Promise<ThreadGoalMutationResult<T>> {
  const key = scopedThreadKey(threadRef);
  if (activeThreadGoalMutations.has(key)) return { status: "busy" };

  activeThreadGoalMutations.add(key);
  try {
    return { status: "completed", value: await mutation() };
  } finally {
    activeThreadGoalMutations.delete(key);
  }
}
