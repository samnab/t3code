import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { resolveThreadProviderSession } from "./threadWorkflows.ts";

export interface ThreadBackgroundTask {
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly canStop: boolean;
}

export function canStopThreadBackgroundTask(
  task: Pick<OrchestrationV2PendingBackgroundTask, "kind">,
  capability: OrchestrationV2ProviderCapabilities["backgroundWork"],
): boolean {
  return capability?.canListTasks === true && capability.stoppableTaskKinds.includes(task.kind);
}

/**
 * Derives the same pending-work roster as the shell and marks only
 * capability-backed stop actions.
 *
 * Pending tasks carry no timestamps, so order comes from the derivation:
 * provider roster first, then turn items oldest to newest. Reversing it lists
 * the newest process first and keeps rows that stay pending in place as
 * newer work arrives.
 */
export function deriveThreadBackgroundWork(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadBackgroundTask> {
  const latestRun = projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
    null,
  );
  const tasks = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs: projection.runs,
  });
  const capability = resolveThreadProviderSession(projection)?.capabilities.backgroundWork;
  // `.reverse()` on a copy, not `.toReversed()`: this runs on Hermes.
  return [...tasks].reverse().map((task) => ({
    task,
    canStop: canStopThreadBackgroundTask(task, capability),
  }));
}
