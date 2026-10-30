import {
  OrchestrationV2BackgroundTaskStopError,
  OrchestrationV2BackgroundTaskUnsupportedError,
  ThreadId,
} from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

export interface ProviderBackgroundTaskServiceV2Shape {
  readonly stop: (input: {
    readonly threadId: ThreadId;
    readonly taskId: string;
  }) => Effect.Effect<
    void,
    OrchestrationV2BackgroundTaskUnsupportedError | OrchestrationV2BackgroundTaskStopError
  >;
}

export class ProviderBackgroundTaskServiceV2 extends Context.Service<
  ProviderBackgroundTaskServiceV2,
  ProviderBackgroundTaskServiceV2Shape
>()("t3/orchestration-v2/ProviderBackgroundTaskService/ProviderBackgroundTaskServiceV2") {}

const isUnsupportedError = Schema.is(OrchestrationV2BackgroundTaskUnsupportedError);
const isStopError = Schema.is(OrchestrationV2BackgroundTaskStopError);

/** The id the adapter knows for a timeline item: its native ref, else the item id. */
const nativeTaskId = (item: {
  readonly id: unknown;
  readonly nativeItemRef?: { readonly nativeId: string | null } | null;
}) => {
  const nativeId = item.nativeItemRef?.nativeId;
  return typeof nativeId === "string" && nativeId.length > 0 ? nativeId : String(item.id);
};

export const layer: Layer.Layer<
  ProviderBackgroundTaskServiceV2,
  never,
  ProjectionStore.ProjectionStoreV2 | ProviderSessionManager.ProviderSessionManagerV2
> = Layer.effect(
  ProviderBackgroundTaskServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

    return ProviderBackgroundTaskServiceV2.of({
      stop: (input) =>
        Effect.gen(function* () {
          const projection = yield* projections.getThreadProjection(input.threadId);
          const rosterMatch = projection.providerThreads
            .flatMap((providerThread) =>
              (providerThread.pendingBackgroundTasks ?? []).map((task) => ({
                providerThread,
                task,
              })),
            )
            .find(({ task }) => task.taskId === input.taskId);
          const item = pendingBackgroundTurnItems({
            turnItems: projection.turnItems,
            runs: projection.runs,
          }).find(
            (candidate) =>
              // Agents only see timeline item ids, so either id addresses the task.
              nativeTaskId(candidate) === input.taskId || String(candidate.id) === input.taskId,
          );
          const itemProviderThread =
            item?.providerThreadId === null || item?.providerThreadId === undefined
              ? undefined
              : projection.providerThreads.find((thread) => thread.id === item.providerThreadId);
          const itemMatch =
            item === undefined || itemProviderThread === undefined
              ? undefined
              : {
                  providerThread: itemProviderThread,
                  task: {
                    taskId: nativeTaskId(item),
                    kind:
                      item.type === "command_execution"
                        ? ("command" as const)
                        : item.type === "subagent"
                          ? ("subagent" as const)
                          : ("background_task" as const),
                  },
                };
          const match = rosterMatch ?? itemMatch;
          if (match === undefined || match.providerThread.providerSessionId === null) {
            return yield* new OrchestrationV2BackgroundTaskStopError({
              reason: "task-not-found",
              threadId: input.threadId,
              taskId: input.taskId,
            });
          }

          const session = yield* sessions.get(match.providerThread.providerSessionId);
          if (Option.isNone(session)) {
            return yield* new OrchestrationV2BackgroundTaskStopError({
              reason: "provider-session-not-active",
              threadId: input.threadId,
              taskId: input.taskId,
            });
          }

          const runtime = session.value;
          const capability = runtime.providerSession.capabilities.backgroundWork;
          if (
            capability === undefined ||
            !capability.stoppableTaskKinds.includes(match.task.kind) ||
            runtime.listBackgroundTasks === undefined ||
            runtime.stopBackgroundTask === undefined
          ) {
            return yield* new OrchestrationV2BackgroundTaskUnsupportedError({
              threadId: input.threadId,
              taskId: input.taskId,
              driver: runtime.driver,
            });
          }

          const liveTasks = yield* runtime.listBackgroundTasks(match.providerThread);
          if (!liveTasks.some((task) => task.taskId === match.task.taskId)) {
            return yield* new OrchestrationV2BackgroundTaskStopError({
              reason: "task-not-found",
              threadId: input.threadId,
              taskId: input.taskId,
            });
          }
          yield* runtime.stopBackgroundTask({
            providerThread: match.providerThread,
            taskId: match.task.taskId,
          });
        }).pipe(
          Effect.mapError((cause) =>
            isUnsupportedError(cause) || isStopError(cause)
              ? cause
              : new OrchestrationV2BackgroundTaskStopError({
                  reason: "unexpected-failure",
                  threadId: input.threadId,
                  taskId: input.taskId,
                  cause,
                }),
          ),
        ),
    });
  }),
);
