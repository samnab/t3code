import type { ContextMenuItem, ThreadGoalLoop } from "@t3tools/contracts";
import { isThreadGoalLoopActionAvailable } from "@t3tools/client-runtime/state/threadGoalEditor";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";

/**
 * Ids for the per-thread action menu. Snooze presets are dispatched as
 * `snooze:<presetId>` so the union stays closed while the preset list
 * remains data-driven.
 */
export type ThreadActionMenuId =
  | "new-thread-on-branch"
  | "project-settings"
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${string}`
  | "unsnooze"
  | "rename"
  | "regenerate-title"
  | "execution-goal"
  | "pause-goal-loop"
  | "resume-goal-loop"
  | "continue-goal-loop"
  | "restart-goal-loop"
  | "stop-goal-loop"
  | "delete-goal"
  | "reload-agent"
  | "mark-unread"
  | "copy"
  | "copy-path"
  | "copy-branch"
  | "copy-thread-id"
  | "archive"
  | "delete";

export interface ThreadActionMenuState {
  readonly branch: string | null;
  readonly isPinned: boolean;
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly canSnoozeNow: boolean;
  readonly isRegeneratingTitle: boolean;
  /** Archive rejects a thread with an active turn, so disable it here rather than let the action fail. */
  readonly isRunning: boolean;
  /** A provider process exists and can be stopped without losing its native resume cursor. */
  readonly hasReloadableSession: boolean;
  readonly supports: {
    readonly settlement: boolean;
    readonly snooze: boolean;
    readonly pinning: boolean;
    readonly titleRegeneration: boolean;
  };
  /** The thread's live session provider exposes native execution goals. */
  readonly executionGoal: boolean;
  /** Saved T3 goal text, independent of whether a loop projection exists. */
  readonly goal: string | null;
  /** Server-driven goal loop state, when the server and thread have one. */
  readonly goalLoop: ThreadGoalLoop | null;
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
}

/**
 * Single source for the per-thread action menu: the sidebar row's right-click
 * menu and the chat header menu both render exactly this list, so labels,
 * ordering, and capability gating cannot drift between the two surfaces.
 */
export function buildThreadActionMenuItems(
  state: ThreadActionMenuState,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  return [
    ...(state.branch
      ? [
          {
            id: "new-thread-on-branch" as const,
            label: `New thread on ${state.branch}`,
            icon: "message-square-plus",
          },
        ]
      : []),
    ...(state.supports.pinning
      ? [
          state.isPinned
            ? { id: "unpin" as const, label: "Unpin thread", icon: "pin-off" }
            : { id: "pin" as const, label: "Pin thread", icon: "pin" },
        ]
      : []),
    // Both lifecycle actions stay available on pinned threads: settling
    // clears the pin ("done" beats "keep on top"), and snoozing hides the
    // card until wake with the pin intact.
    ...(state.supports.settlement
      ? [
          state.isSettled
            ? { id: "unsettle" as const, label: "Un-settle thread", icon: "circle-check" }
            : { id: "settle" as const, label: "Settle thread", icon: "circle-check" },
        ]
      : []),
    ...(state.supports.snooze
      ? [
          state.isSnoozed
            ? { id: "unsnooze" as const, label: "Wake thread", icon: "clock" }
            : {
                id: "snooze" as const,
                label: "Snooze",
                icon: "clock",
                disabled: !state.canSnoozeNow,
                children: [
                  ...state.snoozePresets.map((preset) => ({
                    id: `snooze:${preset.id}` as const,
                    label: `${preset.label} (${preset.whenLabel})`,
                  })),
                  { id: "snooze:custom" as const, label: "Custom…", separatorBefore: true },
                ],
              },
        ]
      : []),
    { id: "rename", label: "Rename thread", icon: "pencil", separatorBefore: true },
    ...(state.supports.titleRegeneration
      ? [
          {
            id: "regenerate-title" as const,
            label: state.isRegeneratingTitle ? "Regenerating…" : "Regenerate title",
            icon: "refresh-cw",
            disabled: state.isRegeneratingTitle,
          },
        ]
      : []),
    ...(isThreadGoalLoopActionAvailable(state.goalLoop, "pause")
      ? [{ id: "pause-goal-loop" as const, label: "Pause goal loop", icon: "pause" }]
      : isThreadGoalLoopActionAvailable(state.goalLoop, "resume")
        ? [{ id: "resume-goal-loop" as const, label: "Resume goal loop", icon: "play" }]
        : isThreadGoalLoopActionAvailable(state.goalLoop, "continue")
          ? [{ id: "continue-goal-loop" as const, label: "Continue anyway", icon: "refresh-cw" }]
          : isThreadGoalLoopActionAvailable(state.goalLoop, "reset")
            ? [{ id: "restart-goal-loop" as const, label: "Restart goal", icon: "refresh-cw" }]
            : []),
    // Stop pauses the loop first and then interrupts the running turn, so it
    // is only offered while a turn is actually active; delete clears the
    // saved goal (stopping active goal work first).
    ...(state.goalLoop !== null && state.isRunning
      ? [{ id: "stop-goal-loop" as const, label: "Stop goal work", icon: "square" }]
      : []),
    ...(state.goal !== null
      ? [
          {
            id: "delete-goal" as const,
            label: "Delete goal",
            icon: "trash",
            destructive: true,
          },
        ]
      : []),
    { id: "mark-unread", label: "Mark unread", icon: "mail-open" },
    // Codex-owned live session state; always named in full so it can never
    // read as the T3 thread goal above the composer.
    ...(state.executionGoal
      ? [
          {
            id: "execution-goal" as const,
            label: "Codex execution goal…",
            icon: "flag",
          },
        ]
      : []),
    ...(state.hasReloadableSession
      ? [
          {
            id: "reload-agent" as const,
            label: "Reload agent",
            icon: "refresh-cw",
            disabled: state.isRunning,
            separatorBefore: true,
          },
        ]
      : []),
    {
      id: "copy",
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      children: [
        { id: "copy-path", label: "Path", icon: "folder" },
        ...(state.branch
          ? [{ id: "copy-branch" as const, label: "Branch", icon: "git-branch" }]
          : []),
        { id: "copy-thread-id", label: "Thread ID", icon: "hash" },
      ],
    },
    { id: "project-settings", label: "Project settings", icon: "settings" },
    // Archive removes the thread from the sidebar while keeping its
    // conversation under Settings > Archived threads — distinct from Settle
    // (stays visible in the Settled shelf) and Delete (clears history for
    // good), so it sits beside Delete without borrowing its destructive
    // styling.
    {
      id: "archive",
      label: "Archive thread",
      icon: "archive",
      disabled: state.isRunning,
      separatorBefore: true,
    },
    {
      id: "delete",
      label: "Delete",
      destructive: true,
      icon: "trash",
    },
  ];
}
