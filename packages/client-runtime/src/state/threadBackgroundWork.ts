import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";

import { resolveThreadProviderSession } from "./threadWorkflows.ts";

export interface ThreadBackgroundTask {
  readonly task: OrchestrationV2PendingBackgroundTask;
  readonly canStop: boolean;
}

export function canStopThreadBackgroundTask(
  task: Pick<OrchestrationV2PendingBackgroundTask, "kind" | "taskId">,
  capability: OrchestrationV2ProviderCapabilities["backgroundWork"],
): boolean {
  // Pull request watches are T3's own monitors, not provider tasks.
  if (task.taskId.startsWith("pull-request-watch:")) return false;
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
  const sessionError =
    projection.providerSessions.findLast(
      (session) => session.providerInstanceId === projection.thread.providerInstanceId,
    )?.lastError ?? null;
  const latestRun =
    usageLimitRunPresentedAsLatest(projection.runs, projection.turnItems, sessionError) ??
    latestUnheldRun(projection.runs);
  const tasks = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs: projection.runs,
    pullRequests: projection.thread.pullRequests,
  });
  const capability = resolveThreadProviderSession(projection)?.capabilities.backgroundWork;
  // `.reverse()` on a copy, not `.toReversed()`: this runs on Hermes.
  return [...tasks].reverse().map((task) => ({
    task,
    canStop: canStopThreadBackgroundTask(task, capability),
  }));
}
