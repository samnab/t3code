import type { ThreadExperimentPhase, ThreadGoalLoop } from "@t3tools/contracts";
import { isThreadGoalLoopActionAvailable } from "@t3tools/client-runtime/state/threadGoalEditor";

export type MobileGoalLoopAction = "pause" | "resume" | "continue";

const PHASE_LABELS: Readonly<Record<ThreadExperimentPhase, string>> = {
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

export function formatExperimentDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function experimentPhaseLabel(phase: ThreadExperimentPhase): string {
  return PHASE_LABELS[phase];
}

export function mobileGoalLoopAction(loop: ThreadGoalLoop | null): MobileGoalLoopAction | null {
  if (isThreadGoalLoopActionAvailable(loop, "pause")) return "pause";
  if (isThreadGoalLoopActionAvailable(loop, "resume")) return "resume";
  if (isThreadGoalLoopActionAvailable(loop, "continue")) return "continue";
  return null;
}

export function mobileGoalLoopStatus(loop: ThreadGoalLoop | null): string | null {
  if (!loop) return null;
  if (loop.kind === "experiment" && loop.experiment) {
    const experiment = loop.experiment;
    return `Experiment · ${PHASE_LABELS[experiment.phase]} · ${experiment.experimentsRun}/${experiment.maxExperiments} · ${formatExperimentDuration(experiment.elapsedSeconds)}/${formatExperimentDuration(experiment.maxTotalSeconds)}`;
  }
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
