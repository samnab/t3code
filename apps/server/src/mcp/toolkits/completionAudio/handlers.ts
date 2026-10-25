import { CompletionAudioError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CompletionNotifications from "../../../orchestration-v2/CompletionNotificationService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, assertLiveCaller } from "../../threadAccess.ts";
import { CompletionAudioToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  const caller = yield* readCaller();
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  if ((yield* environment.getEnvironmentId) !== caller.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return caller;
});
const mapError = (error: CompletionAudioError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "not_found"
        ? "thread_not_found"
        : error.reason === "permission_denied"
          ? "capability_denied"
          : "orchestration_error",
    message: error.message,
  });
const authorization = Effect.gen(function* () {
  const context = yield* Effect.context<
    | McpInvocationContext.McpInvocationContext
    | ServerEnvironment.ServerEnvironmentIdentity
    | ThreadManagement.ThreadManagementService
  >();
  return () =>
    access.pipe(
      Effect.tap(assertLiveCaller),
      Effect.map((caller) => caller.limits),
      Effect.mapError(() => new CompletionAudioError({ reason: "permission_denied" })),
      Effect.provide(context),
    );
});

export const layer = McpToolAccess.toLayer(CompletionAudioToolkit, {
  t3_completion_audio_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const caller = yield* access;
      const service = yield* CompletionNotifications.CompletionNotificationService;
      if (
        input.projectId !== undefined ||
        input.cursor !== undefined ||
        input.limit !== undefined ||
        (input.threadId === undefined && caller.scope.thread === undefined)
      )
        return yield* service.list(input).pipe(Effect.mapError(mapError));
      const threadId = input.threadId ?? caller.scope.thread?.threadId;
      if (threadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Pass threadId or projectId when calling outside a thread.",
        });
      return yield* service.get({ threadId }).pipe(Effect.mapError(mapError));
    }),
  ),
  t3_completion_audio_set: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const caller = yield* access;
        const service = yield* CompletionNotifications.CompletionNotificationService;
        const threadId = input.threadId ?? caller.scope.thread?.threadId;
        if (threadId === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId when calling outside a thread.",
          });
        return yield* service
          .set(
            { ...input, threadId },
            { requestNamespace: caller.scope.requestNamespace, authorize: yield* authorization },
          )
          .pipe(Effect.mapError(mapError));
      }),
  ),
  t3_completion_audio_bulk_off: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const caller = yield* access;
      const service = yield* CompletionNotifications.CompletionNotificationService;
      return yield* service
        .bulkOff(input, {
          requestNamespace: caller.scope.requestNamespace,
          authorize: yield* authorization,
        })
        .pipe(Effect.mapError(mapError));
    }),
  ),
});
