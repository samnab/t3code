import type { ThreadGoalLoop } from "@t3tools/contracts";
import { isThreadGoalLoopActionAvailable } from "@t3tools/client-runtime/state/thread-goal-editor";

export type MobileGoalLoopAction = "pause" | "resume" | "continue";

export function mobileGoalLoopAction(loop: ThreadGoalLoop | null): MobileGoalLoopAction | null {
  if (isThreadGoalLoopActionAvailable(loop, "pause")) return "pause";
  if (isThreadGoalLoopActionAvailable(loop, "resume")) return "resume";
  if (isThreadGoalLoopActionAvailable(loop, "continue")) return "continue";
  return null;
}

export function mobileGoalLoopRestart(loop: ThreadGoalLoop | null): boolean {
  return isThreadGoalLoopActionAvailable(loop, "reset");
}

export function mobileGoalLoopStatus(loop: ThreadGoalLoop | null): string | null {
  if (loop === null) return null;
  switch (loop.state) {
    case "running":
      return `${loop.iterations}/${loop.maxIterations}`;
    case "paused":
      return "Paused";
    case "blocked":
      return "Blocked";
    case "capped":
      return "Capped";
    case "completed":
      return "Complete";
    case "idle":
      return null;
  }
}
