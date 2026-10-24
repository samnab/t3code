import {
  CompletionAudioError,
  type CompletionAudioMetadata,
  type CompletionAudioGetInput,
  type CompletionAudioListInput,
  type CompletionAudioPage,
  type CompletionAudioSetInput,
  type CompletionAudioSetResult,
  type CompletionAudioBulkOffInput,
  type CompletionAudioBulkOffResult,
  type OrchestrationV2ThreadShell,
  resolveCompletionAudio,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { DispatchModeLimit, type DispatchModes } from "./DispatchModeLimit.ts";
import { scopedThreadCommandId } from "./scopedThreadCommandId.ts";

export interface CompletionAudioCaller {
  readonly requestNamespace: string;
  /** Refresh caller modes before each target; dispatch checks them under its existing lock. */
  readonly authorize?: () => Effect.Effect<DispatchModes | undefined, CompletionAudioError>;
}

export class CompletionNotificationService extends Context.Service<
  CompletionNotificationService,
  {
    readonly get: (
      input: CompletionAudioGetInput,
    ) => Effect.Effect<CompletionAudioMetadata, CompletionAudioError>;
    readonly list: (
      input: CompletionAudioListInput,
    ) => Effect.Effect<CompletionAudioPage, CompletionAudioError>;
    readonly set: (
      input: CompletionAudioSetInput,
      caller: CompletionAudioCaller,
    ) => Effect.Effect<CompletionAudioSetResult, CompletionAudioError>;
    readonly bulkOff: (
      input: CompletionAudioBulkOffInput,
      caller: CompletionAudioCaller,
    ) => Effect.Effect<CompletionAudioBulkOffResult, CompletionAudioError>;
  }
>()("t3/orchestration-v2/CompletionNotificationService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const metadata = (thread: OrchestrationV2ThreadShell): CompletionAudioMetadata => {
    const mode = resolveCompletionAudio(thread);
    return {
      environmentId,
      projectId: thread.projectId,
      threadId: thread.id,
      mode,
      voiceNotifications: mode === "voice",
      archived: thread.archivedAt !== null,
    };
  };
  const get = Effect.fn("CompletionNotificationService.get")(function* (
    input: CompletionAudioGetInput,
  ) {
    const thread = yield* threads
      .getThreadShell(input.threadId)
      .pipe(
        Effect.mapError(
          () => new CompletionAudioError({ reason: "failed", threadId: input.threadId }),
        ),
      );
    if (thread === null || thread.deletedAt !== null)
      return yield* new CompletionAudioError({ reason: "not_found", threadId: input.threadId });
    return metadata(thread);
  });
  const all = Effect.fn("CompletionNotificationService.all")(function* (
    projectId?: CompletionAudioListInput["projectId"],
  ) {
    const active = yield* threads
      .getShellSnapshot({ location: "active" })
      .pipe(Effect.mapError(() => new CompletionAudioError({ reason: "failed" })));
    const archive = yield* threads
      .getShellSnapshot({ location: "archive" })
      .pipe(Effect.mapError(() => new CompletionAudioError({ reason: "failed" })));
    const unique = new Map(
      [
        ...active.threads,
        ...active.archivedThreads,
        ...archive.threads,
        ...archive.archivedThreads,
      ].map((thread) => [thread.id, thread]),
    );
    return [...unique.values()]
      .filter(
        (thread) =>
          thread.deletedAt === null && (projectId === undefined || thread.projectId === projectId),
      )
      .toSorted((a, b) => a.id.localeCompare(b.id));
  });
  const list = Effect.fn("CompletionNotificationService.list")(function* (
    input: CompletionAudioListInput,
  ) {
    const items = yield* all(input.projectId);
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? 50;
    return {
      items: items.slice(cursor, cursor + limit).map(metadata),
      nextCursor: cursor + limit < items.length ? cursor + limit : null,
    };
  });
  const set = Effect.fn("CompletionNotificationService.set")(function* (
    input: CompletionAudioSetInput,
    caller: CompletionAudioCaller,
    action = "completion-audio.set",
  ) {
    yield* get(input);
    const limit =
      caller.authorize === undefined ? yield* DispatchModeLimit : yield* caller.authorize();
    const commandId = scopedThreadCommandId({
      requestNamespace: caller.requestNamespace,
      threadId: input.threadId,
      action,
      requestKey: input.clientRequestId,
    });
    const hadReceipt = yield* threads
      .hasReceipt(commandId)
      .pipe(
        Effect.mapError(
          () => new CompletionAudioError({ reason: "failed", threadId: input.threadId }),
        ),
      );
    const result = yield* threads
      .dispatch({
        type: "thread.completion-audio.set",
        commandId,
        threadId: input.threadId,
        mode: input.mode,
      })
      .pipe(
        Effect.provideService(DispatchModeLimit, limit),
        Effect.mapError(
          (error) =>
            new CompletionAudioError({
              reason:
                error._tag === "OrchestratorThreadAboveModeLimitError" ||
                error._tag === "OrchestratorSubagentThreadReadOnlyError"
                  ? "permission_denied"
                  : "failed",
              threadId: input.threadId,
            }),
        ),
      );
    return { commandId, sequence: result.sequence, hadReceipt, state: yield* get(input) };
  });
  const bulkOff = Effect.fn("CompletionNotificationService.bulkOff")(function* (
    input: CompletionAudioBulkOffInput,
    caller: CompletionAudioCaller,
  ) {
    const targets = yield* all(input.projectId);
    let turnedOff = 0;
    let alreadyOff = 0;
    let failedCount = 0;
    const failed: Array<CompletionAudioBulkOffResult["failed"][number]> = [];
    for (const target of targets) {
      const result = yield* set(
        { threadId: target.id, mode: "off", clientRequestId: input.clientRequestId },
        caller,
        "completion-audio.bulk-off",
      ).pipe(Effect.result);
      if (result._tag === "Success" && result.success.state.mode === "off") {
        if (result.success.hadReceipt || resolveCompletionAudio(target) === "off") alreadyOff++;
        else turnedOff++;
      } else {
        failedCount++;
        if (failed.length < 100)
          failed.push(
            result._tag === "Failure"
              ? { threadId: target.id, reason: result.failure.reason }
              : { threadId: target.id, reason: "superseded", mode: result.success.state.mode },
          );
      }
    }
    return {
      environmentId,
      total: targets.length,
      turnedOff,
      alreadyOff,
      failedCount,
      failed,
      failuresTruncated: failedCount > failed.length,
      complete: failedCount === 0,
    };
  });
  return CompletionNotificationService.of({ get, list, set, bulkOff });
});

export const layer = Layer.effect(CompletionNotificationService, make);
