import * as NodeCrypto from "node:crypto";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { Cause, Context, Deferred, Effect, Layer, Schema, Scope, Stream } from "effect";

import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class ChildRunError extends Schema.TaggedErrorClass<ChildRunError>()("ChildRunError", {
  message: Schema.String,
}) {}

export const ChildRunSpawnInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type ChildRunSpawnInput = typeof ChildRunSpawnInput.Type;

export const ChildRunResult = Schema.Struct({
  runId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  title: Schema.String,
  status: Schema.Literals(["starting", "running", "completed", "failed", "cancelled"]),
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type ChildRunResult = typeof ChildRunResult.Type;

export const ChildRunCapabilities = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  providers: Schema.Array(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      displayName: Schema.optional(Schema.String),
    }),
  ),
  maxConcurrentPerParent: Schema.Number,
  persistence: Schema.Literal("server-lifetime"),
  completionDelivery: Schema.Literal("result-or-wait"),
});

interface Run {
  readonly parentThreadId: ThreadId;
  readonly parentSessionId: string;
  readonly done: Deferred.Deferred<void>;
  readonly cancel: Deferred.Deferred<void>;
  result: ChildRunResult;
}

const supported = new Set<string>(["codex", "claudeAgent", "pi"]);
const MAX_OUTPUT = 100_000;
const MAX_PER_PARENT = 4;
const MAX_RUNNING = 16;
const MAX_RETAINED = 256;
const isTerminal = (result: ChildRunResult) =>
  result.status === "completed" || result.status === "failed" || result.status === "cancelled";

export class ChildRunService extends Context.Service<
  ChildRunService,
  {
    capabilities: (
      scope: McpInvocationScope,
    ) => Effect.Effect<typeof ChildRunCapabilities.Type, ChildRunError>;
    spawn: (
      scope: McpInvocationScope,
      input: ChildRunSpawnInput,
    ) => Effect.Effect<ChildRunResult, ChildRunError>;
    result: (
      scope: McpInvocationScope,
      runId: string,
      waitMs?: number,
    ) => Effect.Effect<ChildRunResult, ChildRunError>;
    cancel: (
      scope: McpInvocationScope,
      runId: string,
    ) => Effect.Effect<ChildRunResult, ChildRunError>;
  }
>()("t3/mcp/ChildRunService") {}

/** Runs one bounded turn through a configured native adapter. Child IDs never
 * enter the thread directory, so their events cannot drive parent checkpoints.
 * Results live until server shutdown (up to 256 retained runs); parents collect
 * them through result/wait. No automatic continuation or recursive MCP grant. */
export const layer = Layer.effect(
  ChildRunService,
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const serviceScope = yield* Scope.Scope;
    const runs = new Map<string, Run>();

    const parent = Effect.fn("ChildRunService.parent")(function* (scope: McpInvocationScope) {
      if (!scope.capabilities.has("delegation")) {
        return yield* new ChildRunError({ message: "This session has no delegation capability." });
      }
      const adapter = yield* registry
        .getByInstance(scope.providerInstanceId)
        .pipe(
          Effect.mapError(() => new ChildRunError({ message: "Parent provider is unavailable." })),
        );
      const session = (yield* adapter.listSessions()).find(
        (session) =>
          session.threadId === scope.threadId &&
          session.status !== "closed" &&
          session.status !== "error",
      );
      if (!session)
        return yield* new ChildRunError({ message: "Parent session is no longer active." });
      return session;
    });

    const find = Effect.fn("ChildRunService.find")(function* (
      scope: McpInvocationScope,
      runId: string,
    ) {
      yield* parent(scope);
      const run = runs.get(runId);
      if (
        !run ||
        run.parentThreadId !== scope.threadId ||
        run.parentSessionId !== scope.providerSessionId
      ) {
        return yield* new ChildRunError({ message: "Unknown child run for this session." });
      }
      return run;
    });

    const capabilities = Effect.fn("ChildRunService.capabilities")(function* (
      scope: McpInvocationScope,
    ) {
      const session = yield* parent(scope);
      const instances = yield* registry.listInstances();
      const providers: Array<(typeof ChildRunCapabilities.Type)["providers"][number]> = [];
      for (const id of instances) {
        const info = yield* registry.getInstanceInfo(id).pipe(Effect.option);
        if (info._tag === "Some" && info.value.enabled && supported.has(info.value.driverKind)) {
          providers.push({
            providerInstanceId: id,
            driver: info.value.driverKind,
            ...(info.value.displayName === undefined
              ? {}
              : { displayName: info.value.displayName }),
          });
        }
      }
      return {
        available: session.runtimeMode === "full-access" && session.cwd !== undefined,
        ...(session.runtimeMode !== "full-access"
          ? {
              reason:
                "Cross-provider delegation currently requires a full-access parent because provider sandbox semantics differ.",
            }
          : session.cwd === undefined
            ? { reason: "Parent session has no working directory." }
            : {}),
        providers,
        maxConcurrentPerParent: MAX_PER_PARENT,
        persistence: "server-lifetime" as const,
        completionDelivery: "result-or-wait" as const,
      };
    });

    const spawn = Effect.fn("ChildRunService.spawn")(function* (
      scope: McpInvocationScope,
      input: ChildRunSpawnInput,
    ) {
      const session = yield* parent(scope);
      if (session.runtimeMode !== "full-access" || session.cwd === undefined) {
        return yield* new ChildRunError({
          message: "Delegation requires a full-access parent with a working directory.",
        });
      }
      const info = yield* registry
        .getInstanceInfo(input.providerInstanceId)
        .pipe(Effect.mapError(() => new ChildRunError({ message: "Unknown provider instance." })));
      if (!info.enabled || !supported.has(info.driverKind)) {
        return yield* new ChildRunError({
          message: "Provider instance is disabled or does not support native delegation.",
        });
      }
      const adapter = yield* registry
        .getByInstance(input.providerInstanceId)
        .pipe(
          Effect.mapError(() => new ChildRunError({ message: "Child provider is unavailable." })),
        );
      const done = yield* Deferred.make<void>();
      const cancel = yield* Deferred.make<void>();
      const runId = NodeCrypto.randomUUID();
      const childThreadId = ThreadId.make(`child-${runId}`);
      const run: Run = {
        parentThreadId: scope.threadId,
        parentSessionId: scope.providerSessionId,
        done,
        cancel,
        result: {
          runId,
          providerInstanceId: input.providerInstanceId,
          model: input.model,
          title: input.title,
          status: "starting",
          output: "",
          outputTruncated: false,
        },
      };
      // Reservation has no yield: simultaneous spawn calls cannot overbook.
      const active = [...runs.values()].filter((run) => !isTerminal(run.result));
      if (
        active.length >= MAX_RUNNING ||
        active.filter((run) => run.parentThreadId === scope.threadId).length >= MAX_PER_PARENT
      ) {
        return yield* new ChildRunError({
          message: "Child run concurrency limit reached; collect or cancel existing runs first.",
        });
      }
      if (runs.size >= MAX_RETAINED) {
        const oldest = [...runs].find(([, run]) => isTerminal(run.result));
        if (oldest) runs.delete(oldest[0]);
      }
      runs.set(runId, run);

      const execute = Effect.scoped(
        Effect.gen(function* () {
          const terminal = yield* Deferred.make<Pick<ChildRunResult, "status" | "error">>();
          // Native adapter streams subscribe synchronously on their first pull.
          // Start immediately so even completion inside sendTurn cannot be missed.
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => {
              if (event.threadId !== childThreadId) return Effect.void;
              if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
                const output = run.result.output + event.payload.delta;
                run.result = {
                  ...run.result,
                  output: output.slice(0, MAX_OUTPUT),
                  outputTruncated: run.result.outputTruncated || output.length > MAX_OUTPUT,
                };
              }
              if (event.type === "turn.completed") {
                return Deferred.succeed(terminal, {
                  status:
                    event.payload.state === "completed"
                      ? "completed"
                      : event.payload.state === "failed"
                        ? "failed"
                        : "cancelled",
                  ...(event.payload.errorMessage
                    ? { error: event.payload.errorMessage.slice(0, 2000) }
                    : {}),
                }).pipe(Effect.asVoid);
              }
              if (
                event.type === "turn.aborted" ||
                event.type === "session.exited" ||
                event.type === "runtime.error"
              ) {
                return Deferred.succeed(terminal, {
                  status: "failed",
                  error: "Child provider ended before completing its turn.",
                }).pipe(Effect.asVoid);
              }
              if (event.type === "request.opened" || event.type === "user-input.requested") {
                return Deferred.succeed(terminal, {
                  status: "failed",
                  error: "Child requires interactive input. Run this task in a regular thread.",
                }).pipe(Effect.asVoid);
              }
              return Effect.void;
            }),
            Effect.forkScoped({ startImmediately: true }),
          );

          const work = Effect.gen(function* () {
            yield* adapter.startSession({
              threadId: childThreadId,
              providerInstanceId: input.providerInstanceId,
              cwd: session.cwd,
              title: input.title,
              runtimeMode: session.runtimeMode,
              voiceNotifications: false,
              modelSelection: { instanceId: input.providerInstanceId, model: input.model },
            });
            run.result = { ...run.result, status: "running" };
            yield* adapter.sendTurn({
              threadId: childThreadId,
              input: input.prompt,
              modelSelection: { instanceId: input.providerInstanceId, model: input.model },
            });
            return yield* Deferred.await(terminal);
          });
          const outcome = yield* Effect.raceFirst(
            work,
            Effect.raceFirst(
              Deferred.await(terminal),
              Deferred.await(cancel).pipe(Effect.as({ status: "cancelled" as const })),
            ),
          ).pipe(
            Effect.catch(() =>
              Effect.succeed({
                status: "failed" as const,
                error: "Child provider could not execute the turn.",
              }),
            ),
          );
          // Stop before reporting terminal state so result/wait proves cleanup too.
          let cleanupFailed = false;
          yield* adapter.stopSession(childThreadId).pipe(
            Effect.catch((cause) => {
              cleanupFailed = true;
              return Effect.logWarning("Child session cleanup failed", { childThreadId, cause });
            }),
          );
          run.result = {
            ...run.result,
            ...outcome,
            ...(cleanupFailed
              ? {
                  status: "failed",
                  error: "Child session cleanup failed; inspect the provider session.",
                }
              : {}),
          };
        }),
      ).pipe(
        Effect.onError((cause) =>
          adapter.stopSession(childThreadId).pipe(
            Effect.catch((cleanupCause) =>
              Effect.logWarning("Interrupted child cleanup failed", {
                childThreadId,
                cause: cleanupCause,
              }),
            ),
            Effect.andThen(
              Effect.sync(() => {
                run.result = {
                  ...run.result,
                  status: Cause.hasInterrupts(cause) ? "cancelled" : "failed",
                  error: "Child execution ended before a result could be collected.",
                };
              }),
            ),
          ),
        ),
        Effect.ensuring(Deferred.succeed(done, undefined)),
      );
      yield* execute.pipe(Effect.interruptible, Effect.forkIn(serviceScope));
      return run.result;
    }, Effect.uninterruptible);

    return ChildRunService.of({
      capabilities,
      spawn,
      result: Effect.fn("ChildRunService.result")(function* (scope, runId, waitMs = 0) {
        const run = yield* find(scope, runId);
        if (!isTerminal(run.result) && waitMs > 0) {
          yield* Deferred.await(run.done).pipe(Effect.timeoutOption(Math.min(waitMs, 30_000)));
        }
        return run.result;
      }),
      cancel: Effect.fn("ChildRunService.cancel")(function* (scope, runId) {
        const run = yield* find(scope, runId);
        if (!isTerminal(run.result)) yield* Deferred.succeed(run.cancel, undefined);
        return run.result;
      }),
    });
  }),
);
