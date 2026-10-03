import type { ThreadGoalLoop } from "@t3tools/contracts";
import { isThreadGoalLoopActionAvailable } from "@t3tools/client-runtime/state/thread-goal-editor";

export interface GoalLoopPresentation {
  readonly label: string;
  readonly tone: "idle" | "running" | "paused" | "blocked" | "capped" | "completed";
  readonly pauseAction: "pause" | "resume" | null;
  readonly canContinue: boolean;
  readonly canReset: boolean;
}

/** Presents the standard provider-neutral goal loop without the deferred experiment panel. */
export function describeGoalLoop(loop: ThreadGoalLoop | null): GoalLoopPresentation | null {
  if (loop === null) return null;
  const labelByState: Record<ThreadGoalLoop["state"], string> = {
    idle: "Ready",
    running: "Running",
    paused: "Paused",
    blocked: loop.reason ? `Blocked · ${loop.reason}` : "Blocked",
    completed: "Completed",
    capped: "Iteration limit reached",
  };
  return {
    label: labelByState[loop.state],
    tone: loop.state,
    pauseAction: isThreadGoalLoopActionAvailable(loop, "pause")
      ? "pause"
      : isThreadGoalLoopActionAvailable(loop, "resume")
        ? "resume"
        : null,
    canContinue: isThreadGoalLoopActionAvailable(loop, "continue"),
    canReset: isThreadGoalLoopActionAvailable(loop, "reset"),
  };
}
