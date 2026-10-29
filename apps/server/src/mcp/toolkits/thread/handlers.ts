import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import { formatThreadLink } from "@t3tools/shared/threadLinks";

import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertTargetWithinLimits,
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { hiddenModelMessage } from "../../ModelVisibility.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { ThreadToolkit } from "./tools.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId && request.kind === "user_input",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    });
  return { ...context, request, item };
});
const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(Effect.mapError(unavailable));
      return {
        taskId: task.id,
        threadId,
        lastRunStatus: task.lastRunStatus,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const { matches } = yield* threadSearch
        .searchThreads({ ...input, projectId: input.projectId ?? caller?.projectId })
        .pipe(Effect.mapError(unavailable));
      return {
        matches: matches.map((match) => ({
          ...match,
          link: formatThreadLink(match.threadId, match.title),
        })),
      };
    }),
  ),
  t3_thread_fork: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readThread(input.threadId);
      const commandId = yield* newCommandId();
      const targetThreadId = ThreadId.make(`${commandId}:fork`);
      const result = yield* threads
        .dispatch({
          type: "thread.fork",
          commandId,
          sourceThreadId: projection.thread.id,
          targetThreadId,
          sourcePoint: input.sourcePoint,
          ...(input.title === undefined ? {} : { title: input.title }),
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence, targetThreadId };
    }),
  ),
  t3_thread_merge_back: McpToolAccess.writesThreads(
    (input) => [input.targetThreadId, input.sourceThreadId],
    (input) =>
      Effect.gen(function* () {
        const context = yield* readThread(input.targetThreadId);
        const source = yield* readThread(input.sourceThreadId);
        const result = yield* context.threads
          .dispatch({
            type: "thread.merge_back",
            commandId: yield* newCommandId(),
            sourceThreadId: source.projection.thread.id,
            targetThreadId: input.targetThreadId,
            sourcePoint: input.sourcePoint,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence, targetThreadId: input.targetThreadId };
      }),
  ),
  t3_thread_transfers: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
      return {
        transfers: projection.contextTransfers.map(
          ({ id, sourceThreadId, targetThreadId, status }) => ({
            id,
            sourceThreadId,
            targetThreadId,
            status,
          }),
        ),
      };
    }),
  ),
  t3_thread_configuration: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      return {
        threadId: thread.id,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        autoSettle: thread.autoSettleDisabledAt == null,
        goal: thread.goal ?? null,
        goalLoop: thread.goalLoop ?? null,
      };
    }),
  ),
  t3_thread_configure: writesThread((input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      // An agent may not switch a thread to a model the user hid.
      const hiddenReason = hiddenModelMessage({
        settings: yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
          Effect.mapError(unavailable),
        ),
        providers: yield* (yield* ProviderRegistry.ProviderRegistry).getProviders.pipe(
          Effect.mapError(unavailable),
        ),
        selection: input.modelSelection,
      });
      if (hiddenReason !== null) {
        return yield* new OrchestratorMcpFailure({
          code: "model_unavailable",
          message: hiddenReason,
        });
      }
      const type = modelSelectionCommandType(thread.providerInstanceId, input.modelSelection);
      const result = yield* threads
        .dispatch({
          type,
          threadId: thread.id,
          commandId: yield* newCommandId(),
          modelSelection: input.modelSelection,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  // The orchestrator re-checks the direction under the thread lock; this
  // pre-check only gives the refusal its message.
  t3_thread_lower_modes: writesThread((input) =>
    Effect.gen(function* () {
      const {
        threads,
        projection: { thread },
      } = yield* readThread(input.threadId);
      const runtimeMode = input.runtimeMode ?? thread.runtimeMode;
      const interactionMode = input.interactionMode ?? thread.interactionMode;
      yield* assertTargetWithinLimits(thread, { runtimeMode, interactionMode }).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.code,
              message: "Agents can only lower a thread's modes; raise them in the app.",
            }),
        ),
      );
      const commands: Array<OrchestrationV2Command> = [];
      if (runtimeMode !== thread.runtimeMode)
        commands.push({
          type: "thread.runtime-mode.set",
          commandId: yield* newCommandId(),
          threadId: thread.id,
          runtimeMode,
        });
      if (interactionMode !== thread.interactionMode)
        commands.push({
          type: "thread.interaction-mode.set",
          commandId: yield* newCommandId(),
          threadId: thread.id,
          interactionMode,
        });
      if (commands.length === 0)
        return yield* refuse(`The thread already runs in ${runtimeMode}/${interactionMode} mode.`);
      let sequence = 0;
      for (const command of commands) {
        sequence = (yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure)))
          .sequence;
      }
      return { sequence };
    }),
  ),
  // An idle loop is driven by GoalLoopService, so a goal set here seeds its loop paused.
  t3_thread_goal: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "thread.metadata.update",
      goal: input.goal,
      ...(input.goal === null ? {} : { goalLoopState: "paused" as const }),
    })),
  ),
  // ponytail: expected state is checked before dispatch, not under the thread lock (dispatch
  // takes that lock and it is not reentrant). A guard field on the client loop command would
  // close the window.
  t3_thread_goal_loop: writesThread((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread(input.threadId);
      if (thread.goal == null) return yield* refuse("The thread has no goal.");
      const state = thread.goalLoop?.state ?? "idle";
      if (state !== input.expectedState)
        return yield* refuse(`The goal loop is ${state}, not ${input.expectedState}.`);
      return yield* dispatch(thread.id, (common) => ({
        ...common,
        type: "thread.goal.loop",
        action: input.action,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }));
    }),
  ),
  t3_run_start: writesThread((input) =>
    Effect.gen(function* () {
      // The orchestrator only retries a run whose workspace preparation failed and only starts
      // a queued run while the thread is stopped, so runId is checked atomically there.
      if (input.action === "retry_preparation")
        return yield* dispatch(input.threadId, (common) => ({
          ...common,
          type: "prepared-run.retry",
          runId: input.runId,
        }));
      if (input.action === "start_queued")
        return yield* dispatch(input.threadId, (common) => ({
          ...common,
          type: "queued-run.start",
          runId: input.runId,
        }));
      // ponytail: queue.resume has no expected-run field, so the head is checked before
      // dispatch; a queue edit in that window can change what starts.
      const { threads, projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const next = queuedRunsInDeliveryOrder(projection)[0];
      if (next?.id !== input.runId || next.queueHeld !== true)
        return yield* refuse(
          next === undefined
            ? "The thread has no queued run."
            : next.queueHeld !== true
              ? "The queue is not held."
              : `The next queued run is ${next.id}.`,
        );
      const result = yield* threads
        .dispatch({
          type: "queue.resume",
          commandId: yield* newCommandId(),
          threadId: projection.thread.id,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_pending_request_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
      return {
        requestIds: projection.runtimeRequests
          .filter((request) => request.kind === "user_input" && request.status === "pending")
          .map((request) => request.id),
      };
    }),
  ),
  t3_pending_request_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { item } = yield* readQuestion(input);
      return { requestId: input.requestId, questions: item.questions };
    }),
  ),
  t3_pending_request_respond: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection } = yield* readQuestion(input);
      const result = yield* threads
        .dispatch({
          type: "runtime-request.respond",
          threadId: projection.thread.id,
          commandId: yield* newCommandId(),
          requestId: input.requestId,
          answers: input.answers,
        })
        .pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_queue_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const runs = queuedRunsInDeliveryOrder(projection);
      const cursor = input.cursor ?? 0;
      const end = cursor + (input.limit ?? 20);
      return {
        items: runs.slice(cursor, end).flatMap((run) => {
          const entry = queueEntry(projection, run.id, 1000);
          return entry === undefined ? [] : [entry];
        }),
        nextCursor: end < runs.length ? end : null,
      };
    }),
  ),
  t3_queue_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId, ["runs", "messages"]);
      const entry = queueEntry(projection, input.queuedRunId, 16000);
      return (
        entry ??
        (yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The queued message was not found.",
        }))
      );
    }),
  ),
  t3_queue_edit: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.edit",
      runId: input.queuedRunId,
      text: input.text,
    })),
  ),
  t3_queue_cancel: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.cancel",
      runId: input.queuedRunId,
    })),
  ),
  t3_queue_reorder: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-run.reorder",
      runId: input.queuedRunId,
      beforeRunId: input.beforeRunId,
    })),
  ),
  t3_queue_promote_to_steer: writesThread((input) =>
    dispatch(input.threadId, (common) => ({
      ...common,
      type: "queued-message.promote-to-steer",
      queuedRunId: input.queuedRunId,
      targetRunId: input.targetRunId,
    })),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_read":
          // A read receipt at the version observed by readThread above, never
          // the handler's own clock and never an open or search event.
          command = {
            ...common,
            type: "thread.visit",
            visitedAt: DateTime.formatIso(projection.thread.updatedAt),
          };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        case "enable_auto_settle":
        case "disable_auto_settle":
          command = {
            ...common,
            type: "thread.auto-settle.set",
            enabled: input.action === "enable_auto_settle",
          };
          break;
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
});
