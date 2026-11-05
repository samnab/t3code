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

// Same roster as the shell; only capability-backed tasks get a stop action. Tasks carry no
// timestamps, so the derivation order (provider roster, then turn items oldest first) is
// reversed to list the newest first and keep still-pending rows in place.
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
