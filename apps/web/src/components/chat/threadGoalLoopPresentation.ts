import type { ThreadExperimentPhase, ThreadGoalLoop } from "@t3tools/contracts";
import { isThreadGoalLoopActionAvailable } from "@t3tools/client-runtime/state/threadGoalEditor";

export type GoalLoopTone = "idle" | "running" | "paused" | "blocked" | "capped" | "completed";

export interface GoalLoopPresentation {
  readonly tone: GoalLoopTone;
  readonly tooltip: string | null;
  readonly suffix: string | null;
  readonly pauseAction: "pause" | "resume" | null;
  readonly canContinue: boolean;
  /** Completed loops can be restarted through a reset. */
  readonly canReset: boolean;
}

const EXPERIMENT_PHASE_LABELS: Readonly<Record<ThreadExperimentPhase, string>> = {
  ready: "Ready",
  baseline: "Measuring baseline",
  applying: "Applying candidate",
  evaluating: "Evaluating",
  keeping: "Keeping improvement",
  restoring: "Restoring files",
  paused: "Paused",
  exhausted: "Limits exhausted",
  failed: "Failed",
  complete: "Complete",
};

function compactDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function metric(value: number | null): string {
  return value === null ? "pending" : String(value);
}

function goalLoopActions(
  loop: ThreadGoalLoop | null,
): Pick<GoalLoopPresentation, "pauseAction" | "canContinue" | "canReset"> {
  return {
    pauseAction: isThreadGoalLoopActionAvailable(loop, "pause")
      ? "pause"
      : isThreadGoalLoopActionAvailable(loop, "resume")
        ? "resume"
        : null,
    canContinue: isThreadGoalLoopActionAvailable(loop, "continue"),
    canReset: isThreadGoalLoopActionAvailable(loop, "reset"),
  };
}

/** Compact status for the existing goal pill. No experiment payload is fetched here. */
export function describeGoalLoop(loop: ThreadGoalLoop | null): GoalLoopPresentation {
  const actions = goalLoopActions(loop);
  if (loop === null) {
    return { tone: "idle", tooltip: null, suffix: null, ...actions };
  }

  if (loop.kind === "experiment" && loop.experiment) {
    const experiment = loop.experiment;
    const tone =
      experiment.phase === "paused"
        ? "paused"
        : experiment.phase === "exhausted"
          ? "capped"
          : experiment.phase === "failed"
            ? "blocked"
            : experiment.phase === "complete"
              ? "completed"
              : "running";
    const parts = [
      `Experiment · ${EXPERIMENT_PHASE_LABELS[experiment.phase]}`,
      `baseline ${metric(experiment.baselineMetric)}`,
      `best ${metric(experiment.bestMetric)}`,
      `${experiment.experimentsRun}/${experiment.maxExperiments} experiments`,
      `${compactDuration(experiment.elapsedSeconds)}/${compactDuration(experiment.maxTotalSeconds)}`,
    ];
    if (experiment.lastError) parts.push(`last error: ${experiment.lastError}`);
    return {
      tone,
      tooltip: parts.join(" · "),
      suffix: `Exp ${experiment.experimentsRun}/${experiment.maxExperiments}`,
      ...actions,
    };
  }

  switch (loop.state) {
    case "running":
      return {
        tone: "running",
        tooltip: `Working toward the goal · iteration ${loop.iterations} of ${loop.maxIterations}`,
        suffix: `${loop.iterations}/${loop.maxIterations}`,
        ...actions,
      };
    case "paused":
      return { tone: "paused", tooltip: "Goal loop paused", suffix: null, ...actions };
    case "blocked":
      return {
        tone: "blocked",
        tooltip: loop.reason ? `Goal loop blocked · ${loop.reason}` : "Goal loop blocked",
        suffix: null,
        ...actions,
      };
    case "capped":
      return {
        tone: "capped",
        tooltip: `Reached ${loop.iterations} iterations`,
        suffix: null,
        ...actions,
      };
    case "completed":
      return { tone: "completed", tooltip: "Goal complete", suffix: null, ...actions };
    case "idle":
      return { tone: "idle", tooltip: null, suffix: null, ...actions };
  }
}
