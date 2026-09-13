import type { ThreadGoalLoop } from "@t3tools/contracts";

interface ThreadGoalState {
  readonly goal: string | null | undefined;
  readonly goalLoop: ThreadGoalLoop | null | undefined;
}

/** Standard goals always belong to T3; experiments may opt into T3 mode. */
export function getT3GoalInjection(thread: ThreadGoalState): string | null {
  const loop = thread.goalLoop;
  if (thread.goal == null || loop == null || (loop.kind !== "standard" && loop.mode !== "t3")) {
    return null;
  }
  return formatThreadGoalInjection({
    goal: thread.goal,
    iteration: loop.iterations,
    maxIterations: loop.maxIterations,
  });
}

/** A standard goal and a live Codex session must never have two goal drivers. */
export function requiresCodexGoalDeactivation(
  thread: ThreadGoalState,
  provider: string | undefined,
): boolean {
  return thread.goal != null && thread.goalLoop?.kind === "standard" && provider === "codex";
}

/** Provider-only prompt block for one T3-driven goal turn. */
export function formatThreadGoalInjection(input: {
  readonly goal: string;
  readonly iteration: number;
  readonly maxIterations: number;
}): string {
  return [
    `<thread_goal iteration="${input.iteration}" max="${input.maxIterations}">`,
    input.goal,
    "</thread_goal>",
    "This thread goal is owned by T3. Do not create or update a provider-native goal. Use T3's agent tools for cross-provider child work, and do not create recursive goals for children. Only you, the root agent of this thread, may signal its status: delegates and subagents report to you and never emit these tags. When the goal is fully met and verified, end your reply with <goal_complete>. If you cannot proceed without the user, end your reply with <goal_blocked>one-line reason</goal_blocked>. Otherwise keep working; T3 will ask you to continue.",
  ].join("\n");
}
