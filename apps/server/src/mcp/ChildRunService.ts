import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  SubagentControlError,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  Layer,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { NativeChildRunRepositoryAuto } from "../persistence/Layers/NativeChildRuns.ts";
import {
  NativeChildRunRepository,
  NativeChildRun,
  NATIVE_CHILD_RESTART_ERROR,
} from "../persistence/Services/NativeChildRuns.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderSubagentControlPlaneShape,
} from "../provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
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

export const ChildRunSendInput = Schema.Struct({
  runId: RuntimeTaskId,
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
});
export type ChildRunSendInput = typeof ChildRunSendInput.Type;

export const ChildRunResult = Schema.Struct({
  runId: RuntimeTaskId,
  generation: Schema.Int,
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
      available: Schema.Boolean,
      reason: Schema.optional(Schema.String),
    }),
  ),
  maxConcurrentPerParent: Schema.Number,
  persistence: Schema.Literal("durable"),
  completionDelivery: Schema.Literal("automatic-or-result"),
});

interface ActiveRun {
  readonly run: NativeChildRun;
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly parentProviderInstanceId: ProviderInstanceId;
  readonly done: Deferred.Deferred<void>;
  readonly cancel: Deferred.Deferred<void>;
  readonly terminal: Deferred.Deferred<{
    readonly status: "completed" | "failed" | "cancelled";
    readonly error?: string;
  }>;
  output: string;
  outputTruncated: boolean;
  resumeCursor: unknown | null;
  suppressDelivery: boolean;
  sessionStarted: boolean;
  sessionStopped: boolean;
  expectedTurnId: TurnId | null;
  readonly steerMutex: Semaphore.Semaphore;
  pendingSteers: number;
  pendingCompletions: Array<{
    readonly turnId: TurnId | null;
    readonly outcome: {
      readonly status: "completed" | "failed" | "cancelled";
      readonly error?: string;
    };
  }>;
}

const supported = new Set<string>(["codex", "claudeAgent", "pi"]);
const MAX_OUTPUT = 100_000;
const MAX_PER_PARENT = 4;
const MAX_RUNNING = 16;
const decodeRuntimeTaskId = Schema.decodeUnknownEffect(RuntimeTaskId);
const NATIVE_CONTROL_CAPABILITIES = {
  normalizedEvents: true,
  stableActivations: true,
  ownerRouting: true,
  steering: true,
  cancellation: true,
  reloadRestore: false,
  scheduling: false,
  nativeChildProjection: true,
  deliveryAcknowledgements: true,
  childTranscripts: false,
} as const;
const isTerminal = (run: NativeChildRun) =>
  run.status === "completed" || run.status === "failed" || run.status === "cancelled";
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function nativeManagerId(threadId: ThreadId): string {
  return `t3-native:${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32)}`;
}

function toResult(run: NativeChildRun): ChildRunResult {
  return {
    runId: run.runId,
    generation: run.generation,
    providerInstanceId: run.providerInstanceId,
    model: run.model,
    title: run.title,
    status: run.status,
    output: run.output,
    outputTruncated: run.outputTruncated,
    ...(run.error === null ? {} : { error: run.error }),
  };
}

function providerAvailability(driver: string, runtimeMode: ProviderSession["runtimeMode"]) {
  if (!supported.has(driver)) {
    return { available: false, reason: "This provider has no native delegation adapter." };
  }
  if (driver === "pi" && runtimeMode !== "full-access") {
    return {
      available: false,
      reason:
        "Restricted Pi children are unavailable because Pi does not enforce an equivalent non-interactive sandbox.",
    };
  }
  return { available: true };
}

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
    send: (
      scope: McpInvocationScope,
      input: ChildRunSendInput,
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
    readonly controlPlane: ProviderSubagentControlPlaneShape<never>;
  }
>()("t3/mcp/ChildRunService") {}

/** Runs native children without granting them T3 MCP credentials. */
const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const providers = yield* ProviderService;
  const repository = yield* NativeChildRunRepository;
  const engine = yield* OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup;
  const serviceScope = yield* Scope.Scope;
  const spawnMutex = yield* Semaphore.make(1);
  const activeByRun = new Map<RuntimeTaskId, ActiveRun>();
  const activeByThread = new Map<ThreadId, ActiveRun>();
  const stoppedParents = new Set<ThreadId>();
  const parentProviderByThread = new Map<ThreadId, ProviderInstanceId>();

  const persistenceError = (operation: string) => (_cause: unknown) =>
    new ChildRunError({ message: `${operation} failed.` });

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
      (candidate) =>
        candidate.threadId === scope.threadId &&
        candidate.status !== "closed" &&
        candidate.status !== "error",
    );
    if (session === undefined) {
      return yield* new ChildRunError({ message: "Parent session is no longer active." });
    }
    return session;
  });

  const readOwned = Effect.fn("ChildRunService.readOwned")(function* (
    scope: McpInvocationScope,
    runId: string,
  ) {
    yield* parent(scope);
    const decodedId = yield* decodeRuntimeTaskId(runId).pipe(
      Effect.mapError(() => new ChildRunError({ message: "Invalid child run identifier." })),
    );
    const run = yield* repository
      .get(decodedId)
      .pipe(Effect.mapError(persistenceError("Reading the child run")));
    if (run === null || run.parentThreadId !== scope.threadId) {
      return yield* new ChildRunError({ message: "Unknown child run for this thread." });
    }
    return run;
  });

  const activity = Effect.fn("ChildRunService.activity")(function* (
    run: NativeChildRun,
    status: "active" | "done" | "error" | "cancelled" | "interrupted",
    summary: string,
  ) {
    const createdAt = yield* nowIso;
    yield* startup
      .enqueueCommand(
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:native-child:${run.runId}:${status}`),
          threadId: run.parentThreadId,
          activity: {
            id: EventId.make(`native-child:${run.runId}:${status}`),
            tone: status === "error" ? "error" : "tool",
            kind: status === "active" ? "task.started" : "task.completed",
            summary,
            payload: {
              taskId: run.runId,
              taskType: "subagent",
              agentKind: "agent",
              title: run.title,
              role: run.provider,
              model: run.model,
              status:
                status === "done"
                  ? "completed"
                  : status === "error"
                    ? "failed"
                    : status === "active"
                      ? "running"
                      : status,
              ...(status === "active" ? {} : { summary }),
              subagentRun: {
                runId: run.runId,
                ...(status === "active" ? { runNumber: run.runNumber } : {}),
                ...(run.parentRunId === null ? {} : { parentRunId: run.parentRunId }),
                runtimeFamily: "t3-native",
                harness: run.provider,
                provider: run.provider,
                providerInstanceId: run.providerInstanceId,
                status,
                ...(status === "done"
                  ? { terminalReason: "native-completed" as const }
                  : status === "error"
                    ? { terminalReason: "native-error" as const }
                    : status === "cancelled"
                      ? { terminalReason: "native-cancelled" as const }
                      : status === "interrupted"
                        ? { terminalReason: "server-restart" as const }
                        : {}),
                controlAvailability: status === "active" ? "owner-routed" : "read-only",
                historyAvailability: "summary-only",
                capabilities: {
                  steer: status === "active",
                  cancel: status === "active",
                  resume: false,
                },
                startedAt: run.createdAt,
              },
            },
            turnId: null,
            createdAt,
          },
          createdAt,
        }),
      )
      .pipe(Effect.mapError(persistenceError("Publishing child activity")));
  });

  const deliveryText = (run: NativeChildRun) => {
    const body = run.output.length > 0 ? run.output : (run.error ?? "No output was returned.");
    return `[T3 subagent result: ${run.title} (${run.provider}/${run.model}, ${run.status}, run ${run.runId})]\n${body}`;
  };

  const deliver = Effect.fn("ChildRunService.deliver")(function* (run: NativeChildRun) {
    if (run.deliveryState === "delivered") return;
    if (run.deliveryState === "suppressed" || stoppedParents.has(run.parentThreadId)) {
      yield* repository
        .markDelivered(run.runId)
        .pipe(Effect.mapError(persistenceError("Suppressing delivery after parent stop")));
      return;
    }
    const createdAt = yield* nowIso;
    const outcome = yield* startup
      .enqueueCommand(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(
            `server:native-child-delivery:${run.runId}:${run.deliveryAttempt}`,
          ),
          threadId: run.parentThreadId,
          message: {
            messageId: MessageId.make(`native-child-delivery:${run.runId}:${run.deliveryAttempt}`),
            role: "user",
            text: deliveryText(run),
            attachments: [],
          },
          runtimeMode: run.runtimeMode,
          interactionMode: "default",
          onlyIfIdle: true,
          createdAt,
        }),
      )
      .pipe(Effect.result);
    yield* (
      outcome._tag === "Success"
        ? repository.markDelivered(run.runId)
        : repository.markDeliveryRetry(run.runId)
    ).pipe(Effect.mapError(persistenceError("Recording child result delivery")));
  });

  const deliverPending = Effect.fn("ChildRunService.deliverPending")(function* (
    parentThreadId?: ThreadId,
  ) {
    const pending = yield* repository
      .listPendingDelivery(parentThreadId)
      .pipe(Effect.mapError(persistenceError("Listing pending child results")));
    yield* Effect.forEach(pending, deliver, { concurrency: 1, discard: true });
  });

  const stopActiveSession = Effect.fn("ChildRunService.stopActiveSession")(function* (
    active: ActiveRun,
  ) {
    if (!active.sessionStarted || active.sessionStopped) return true;
    const stopped = yield* active.adapter.stopSession(active.run.childThreadId).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("Child session cleanup failed", {
          childThreadId: active.run.childThreadId,
          cause,
        }).pipe(Effect.as(false)),
      ),
      Effect.ensuring(Effect.sync(() => (active.sessionStopped = true))),
      Effect.uninterruptible,
    );
    return stopped;
  });

  const finish = Effect.fn("ChildRunService.finish")(function* (
    active: ActiveRun,
    outcome: { readonly status: "completed" | "failed" | "cancelled"; readonly error?: string },
  ) {
    const stopped = yield* stopActiveSession(active);
    const updatedAt = yield* nowIso;
    const status = stopped ? outcome.status : "failed";
    const error = stopped
      ? (outcome.error ?? null)
      : "Child session cleanup failed; inspect the provider session.";
    yield* repository
      .markTerminal({
        runId: active.run.runId,
        status,
        output: active.output,
        outputTruncated: active.outputTruncated,
        error,
        resumeCursor: active.resumeCursor,
        updatedAt,
      })
      .pipe(Effect.mapError(persistenceError("Persisting child completion")));
    activeByRun.delete(active.run.runId);
    activeByThread.delete(active.run.childThreadId);
    const stored = yield* repository
      .get(active.run.runId)
      .pipe(Effect.mapError(persistenceError("Reading child completion")));
    if (stored !== null) {
      yield* activity(
        stored,
        status === "completed" ? "done" : status === "cancelled" ? "cancelled" : "error",
        status === "completed" ? active.output || "Completed" : (error ?? status),
      );
      if (active.suppressDelivery) {
        yield* repository
          .markDelivered(stored.runId)
          .pipe(Effect.mapError(persistenceError("Suppressing delivery after parent stop")));
      } else {
        yield* deliver(stored);
      }
    }
  });

  const makeActive = Effect.fn("ChildRunService.makeActive")(function* (
    run: NativeChildRun,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
    parentProviderInstanceId: ProviderInstanceId,
  ) {
    const active: ActiveRun = {
      run,
      adapter,
      parentProviderInstanceId,
      done: yield* Deferred.make<void>(),
      cancel: yield* Deferred.make<void>(),
      terminal: yield* Deferred.make<{
        readonly status: "completed" | "failed" | "cancelled";
        readonly error?: string;
      }>(),
      output: "",
      outputTruncated: false,
      resumeCursor: run.resumeCursor,
      suppressDelivery: false,
      sessionStarted: false,
      sessionStopped: false,
      expectedTurnId: null,
      steerMutex: yield* Semaphore.make(1),
      pendingSteers: 0,
      pendingCompletions: [],
    };
    activeByRun.set(run.runId, active);
    activeByThread.set(run.childThreadId, active);
    return active;
  });

  const execute = Effect.fn("ChildRunService.execute")(function* (
    active: ActiveRun,
    prompt: string,
  ) {
    const { run, adapter } = active;
    const work = Effect.gen(function* () {
      const session = yield* adapter.startSession({
        threadId: run.childThreadId,
        providerInstanceId: run.providerInstanceId,
        cwd: run.cwd,
        title: run.title,
        runtimeMode: run.runtimeMode,
        voiceNotifications: false,
        modelSelection: { instanceId: run.providerInstanceId, model: run.model },
        ...(run.resumeCursor === null ? {} : { resumeCursor: run.resumeCursor }),
      });
      active.sessionStarted = true;
      active.resumeCursor = session.resumeCursor ?? active.resumeCursor;
      const turn = yield* adapter.sendTurn({
        threadId: run.childThreadId,
        input: prompt,
        modelSelection: { instanceId: run.providerInstanceId, model: run.model },
      });
      active.expectedTurnId = turn.turnId;
      active.resumeCursor = turn.resumeCursor ?? active.resumeCursor;
      yield* repository
        .markRunning({
          runId: run.runId,
          resumeCursor: active.resumeCursor,
          updatedAt: yield* nowIso,
        })
        .pipe(Effect.mapError(persistenceError("Persisting child session identity")));
      return yield* Deferred.await(active.terminal);
    });

    yield* Effect.gen(function* () {
      const outcome = yield* Effect.raceFirst(
        work,
        Deferred.await(active.cancel).pipe(Effect.as({ status: "cancelled" as const })),
      ).pipe(
        Effect.orElseSucceed(() => ({
          status: "failed" as const,
          error: "Child provider could not execute the turn.",
        })),
      );
      yield* finish(active, outcome);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* stopActiveSession(active);
          activeByRun.delete(run.runId);
          activeByThread.delete(run.childThreadId);
          yield* Deferred.succeed(active.done, undefined);
        }),
      ),
    );
  });

  const steerActive = Effect.fn("ChildRunService.steerActive")(function* (
    active: ActiveRun,
    prompt: string,
  ) {
    const releaseSteering = (expectedTurnId?: TurnId) =>
      Effect.gen(function* () {
        if (expectedTurnId !== undefined) active.expectedTurnId = expectedTurnId;
        active.pendingSteers = Math.max(0, active.pendingSteers - 1);
        if (active.pendingSteers > 0) return;
        const completion =
          expectedTurnId === undefined
            ? active.pendingCompletions.at(-1)
            : active.pendingCompletions.find(
                (candidate) => candidate.turnId === null || candidate.turnId === expectedTurnId,
              );
        active.pendingCompletions.length = 0;
        if (completion !== undefined) {
          yield* Deferred.succeed(active.terminal, completion.outcome);
        }
      });
    active.pendingSteers += 1;
    let released = false;
    yield* Effect.gen(function* () {
      const turn = yield* active.adapter
        .sendTurn({
          threadId: active.run.childThreadId,
          input: prompt,
          modelSelection: {
            instanceId: active.run.providerInstanceId,
            model: active.run.model,
          },
        })
        .pipe(Effect.mapError(() => new ChildRunError({ message: "Child steering failed." })));
      yield* releaseSteering(turn.turnId);
      released = true;
      active.resumeCursor = turn.resumeCursor ?? active.resumeCursor;
      yield* repository
        .markRunning({
          runId: active.run.runId,
          resumeCursor: active.resumeCursor,
          updatedAt: yield* nowIso,
        })
        .pipe(Effect.mapError(persistenceError("Persisting child session identity")));
    }).pipe(
      active.steerMutex.withPermits(1),
      Effect.ensuring(Effect.suspend(() => (released ? Effect.void : releaseSteering()))),
    );
  });

  const start = Effect.fn("ChildRunService.start")(
    function* (
      scope: McpInvocationScope,
      session: ProviderSession,
      input: ChildRunSpawnInput,
      parentRunId: RuntimeTaskId | null,
      resumeCursor: unknown | null,
      generation: number,
    ) {
      if (session.cwd === undefined) {
        return yield* new ChildRunError({ message: "Parent session has no working directory." });
      }
      parentProviderByThread.set(scope.threadId, scope.providerInstanceId);
      stoppedParents.delete(scope.threadId);
      const info = yield* registry
        .getInstanceInfo(input.providerInstanceId)
        .pipe(Effect.mapError(() => new ChildRunError({ message: "Unknown provider instance." })));
      const availability = providerAvailability(info.driverKind, session.runtimeMode);
      if (!info.enabled || !availability.available) {
        return yield* new ChildRunError({
          message: availability.reason ?? "Provider instance is disabled.",
        });
      }
      const existing = yield* repository
        .listActive()
        .pipe(Effect.mapError(persistenceError("Checking child concurrency")));
      if (
        existing.length >= MAX_RUNNING ||
        existing.filter((candidate) => candidate.parentThreadId === scope.threadId).length >=
          MAX_PER_PARENT
      ) {
        return yield* new ChildRunError({ message: "Child run concurrency limit reached." });
      }
      const adapter = yield* registry
        .getByInstance(input.providerInstanceId)
        .pipe(
          Effect.mapError(() => new ChildRunError({ message: "Child provider is unavailable." })),
        );
      const createdAt = yield* nowIso;
      const id = NodeCrypto.randomUUID();
      const runId = RuntimeTaskId.make(`native-${id}`);
      const childThreadId = ThreadId.make(`child-${id}`);
      const runNumber = yield* repository
        .reserveRunNumber({ runId, allocatedAt: createdAt, childThreadId })
        .pipe(Effect.mapError(persistenceError("Reserving the child inventory row")));
      const run = NativeChildRun.make({
        runId,
        runNumber,
        parentRunId,
        parentThreadId: scope.threadId,
        childThreadId,
        providerInstanceId: input.providerInstanceId,
        provider: info.driverKind,
        model: input.model,
        title: input.title,
        runtimeMode: session.runtimeMode,
        cwd: session.cwd,
        resumeCursor,
        generation,
        status: "starting",
        output: "",
        outputTruncated: false,
        error: null,
        deliveryState: "pending",
        deliveryAttempt: 0,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.insert(run).pipe(Effect.mapError(persistenceError("Persisting child run")));
      const active = yield* makeActive(run, adapter, scope.providerInstanceId);
      if (stoppedParents.has(scope.threadId)) {
        yield* repository
          .markTerminal({
            runId: run.runId,
            status: "cancelled",
            output: "",
            outputTruncated: false,
            error: "Parent session stopped while the child was starting.",
            resumeCursor: null,
            updatedAt: createdAt,
          })
          .pipe(
            Effect.andThen(repository.markDelivered(run.runId)),
            Effect.mapError(persistenceError("Cancelling child startup after parent stop")),
            Effect.ensuring(
              Effect.sync(() => {
                activeByRun.delete(run.runId);
                activeByThread.delete(run.childThreadId);
              }).pipe(Effect.andThen(Deferred.succeed(active.done, undefined))),
            ),
          );
        return yield* new ChildRunError({ message: "Parent session is no longer active." });
      }
      yield* activity(run, "active", input.title).pipe(
        Effect.catch((cause) =>
          repository
            .markTerminal({
              runId: run.runId,
              status: "failed",
              output: "",
              outputTruncated: false,
              error: "T3 Code could not publish the child run to Agents.",
              resumeCursor: null,
              updatedAt: createdAt,
            })
            .pipe(
              Effect.andThen(repository.markDelivered(run.runId)),
              Effect.mapError(persistenceError("Rolling back child startup")),
              Effect.ensuring(
                Effect.sync(() => {
                  activeByRun.delete(run.runId);
                  activeByThread.delete(run.childThreadId);
                }).pipe(Effect.andThen(Deferred.succeed(active.done, undefined))),
              ),
              Effect.andThen(Effect.fail(cause)),
            ),
        ),
      );
      yield* execute(active, input.prompt).pipe(
        Effect.onError((cause) =>
          Effect.logError("Native child execution failed", { runId: run.runId, cause }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            activeByRun.delete(run.runId);
            activeByThread.delete(run.childThreadId);
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(serviceScope, { startImmediately: true }),
      );
      return toResult(run);
    },
    spawnMutex.withPermits(1),
    Effect.uninterruptible,
  );

  const completeChildTurn = (
    child: ActiveRun,
    turnId: TurnId | undefined,
    outcome: {
      readonly status: "completed" | "failed" | "cancelled";
      readonly error?: string;
    },
  ) => {
    if (child.pendingSteers > 0) {
      return Effect.sync(() => {
        child.pendingCompletions.push({ turnId: turnId ?? null, outcome });
        if (child.pendingCompletions.length > 4) child.pendingCompletions.shift();
      });
    }
    if (child.expectedTurnId !== null && turnId !== undefined && turnId !== child.expectedTurnId) {
      return Effect.void;
    }
    return Deferred.succeed(child.terminal, outcome).pipe(Effect.asVoid);
  };

  const suppressParent = (
    threadId: ThreadId,
    providerInstanceId?: ProviderInstanceId,
  ): Effect.Effect<void> => {
    const candidates = [...activeByRun.values()].filter(
      (candidate) =>
        candidate.run.parentThreadId === threadId &&
        (providerInstanceId === undefined ||
          candidate.parentProviderInstanceId === providerInstanceId),
    );
    if (
      providerInstanceId !== undefined &&
      parentProviderByThread.get(threadId) !== providerInstanceId
    ) {
      return Effect.void;
    }
    return Effect.gen(function* () {
      stoppedParents.add(threadId);
      yield* repository.markParentDelivered(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to suppress pending child delivery after parent stop", {
            threadId,
            cause,
          }),
        ),
      );
      yield* Effect.forEach(
        candidates,
        (candidate) =>
          Effect.sync(() => {
            candidate.suppressDelivery = true;
          }).pipe(Effect.andThen(Deferred.succeed(candidate.cancel, undefined))),
        { discard: true },
      );
    });
  };

  const onProviderEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    const child = activeByThread.get(event.threadId);
    if (child !== undefined) {
      if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
        return Effect.sync(() => {
          const output = child.output + event.payload.delta;
          child.output = output.slice(0, MAX_OUTPUT);
          child.outputTruncated ||= output.length > MAX_OUTPUT;
        });
      }
      if (event.type === "turn.completed") {
        const outcome: {
          readonly status: "completed" | "failed" | "cancelled";
          readonly error?: string;
        } = {
          status:
            event.payload.state === "completed"
              ? "completed"
              : event.payload.state === "failed"
                ? "failed"
                : "cancelled",
          ...(event.payload.errorMessage === undefined
            ? {}
            : { error: event.payload.errorMessage.slice(0, 2_000) }),
        };
        return completeChildTurn(child, event.turnId, outcome);
      }
      if (event.type === "turn.aborted") {
        return completeChildTurn(child, event.turnId, {
          status: "failed",
          error: "Child provider ended before completing its turn.",
        });
      }
      if (event.type === "session.exited" || event.type === "runtime.error") {
        return Deferred.succeed(child.terminal, {
          status: "failed",
          error: "Child provider ended before completing its turn.",
        }).pipe(Effect.asVoid);
      }
      if (event.type === "request.opened" || event.type === "user-input.requested") {
        return Deferred.succeed(child.terminal, {
          status: "failed",
          error: "Child requires interactive input. Run this task in a regular thread.",
        }).pipe(Effect.asVoid);
      }
      return Effect.void;
    }
    return event.type === "session.exited"
      ? suppressParent(event.threadId, event.providerInstanceId)
      : Effect.void;
  };

  // ProviderService is the sole adapter event consumer and fans out here.
  yield* providers.streamEvents.pipe(
    Stream.runForEach(onProviderEvent),
    Effect.forkIn(serviceScope, { startImmediately: true }),
  );

  const domainEvents = yield* engine.subscribeDomainEvents.pipe(
    Effect.provideService(Scope.Scope, serviceScope),
  );
  yield* domainEvents.pipe(
    Stream.runForEach((event) => {
      if (event.type === "thread.session-stop-requested") {
        return suppressParent(event.payload.threadId);
      }
      return event.type === "thread.turn-diff-completed"
        ? deliverPending(event.payload.threadId).pipe(Effect.catchCause(Effect.logWarning))
        : Effect.void;
    }),
    Effect.forkIn(serviceScope, { startImmediately: true }),
  );

  yield* repository
    .reconcileRestart(yield* nowIso)
    .pipe(Effect.mapError(persistenceError("Reconciling child runs after restart")));
  yield* Effect.gen(function* () {
    const pending = yield* repository
      .listPendingDelivery()
      .pipe(Effect.mapError(persistenceError("Listing pending child results")));
    yield* Effect.forEach(
      pending,
      (run) =>
        Effect.gen(function* () {
          yield* activity(run, "active", run.title);
          const terminalStatus =
            run.status === "completed"
              ? ("done" as const)
              : run.status === "cancelled"
                ? ("cancelled" as const)
                : run.error === NATIVE_CHILD_RESTART_ERROR
                  ? ("interrupted" as const)
                  : ("error" as const);
          yield* activity(run, terminalStatus, run.output || run.error || run.status);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Native child projection repair failed", {
              runId: run.runId,
              cause,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
    yield* deliverPending();
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Native child restart reconciliation failed", cause),
    ),
    Effect.forkIn(serviceScope, { startImmediately: true }),
  );

  const controlPlane = {
    status: () =>
      Effect.sync(() => {
        const parents = new Set<ThreadId>();
        const statuses = [];
        for (const active of activeByRun.values()) {
          if (active.sessionStopped || parents.has(active.run.parentThreadId)) continue;
          parents.add(active.run.parentThreadId);
          statuses.push({
            supported: true as const,
            threadId: active.run.parentThreadId,
            managerId: nativeManagerId(active.run.parentThreadId),
            protocolVersion: 1,
            capabilities: NATIVE_CONTROL_CAPABILITIES,
            controls: { steer: { enabled: true }, cancel: { enabled: true } },
          });
        }
        return statuses;
      }),
    steer: (input) =>
      Effect.gen(function* () {
        const active = activeByRun.get(input.runId);
        if (active === undefined || active.sessionStopped) {
          return yield* new SubagentControlError({ reason: "unknown-run" });
        }
        if (nativeManagerId(active.run.parentThreadId) !== input.managerId) {
          return yield* new SubagentControlError({ reason: "manager-mismatch" });
        }
        yield* steerActive(active, input.text).pipe(
          Effect.mapError(
            (error) =>
              new SubagentControlError({ reason: "manager-rejected", detail: error.message }),
          ),
        );
        return { accepted: true as const };
      }),
    cancel: (input) =>
      Effect.gen(function* () {
        const active = activeByRun.get(input.runId);
        if (active === undefined || active.sessionStopped) {
          return yield* new SubagentControlError({ reason: "unknown-run" });
        }
        if (nativeManagerId(active.run.parentThreadId) !== input.managerId) {
          return yield* new SubagentControlError({ reason: "manager-mismatch" });
        }
        yield* Deferred.succeed(active.cancel, undefined);
        return { accepted: true as const };
      }),
  } satisfies ProviderSubagentControlPlaneShape<never>;

  return ChildRunService.of({
    controlPlane,
    capabilities: Effect.fn("ChildRunService.capabilities")(function* (scope) {
      const session = yield* parent(scope);
      const instances = yield* registry.listInstances();
      const targetProviders: Array<(typeof ChildRunCapabilities.Type)["providers"][number]> = [];
      for (const id of instances) {
        const info = yield* registry.getInstanceInfo(id).pipe(Effect.option);
        if (info._tag === "None" || !info.value.enabled || !supported.has(info.value.driverKind)) {
          continue;
        }
        const availability = providerAvailability(info.value.driverKind, session.runtimeMode);
        targetProviders.push({
          providerInstanceId: id,
          driver: info.value.driverKind,
          ...(info.value.displayName === undefined ? {} : { displayName: info.value.displayName }),
          ...availability,
        });
      }
      const available =
        session.cwd !== undefined && targetProviders.some((candidate) => candidate.available);
      return {
        available,
        ...(available
          ? {}
          : {
              reason:
                session.cwd === undefined
                  ? "Parent session has no working directory."
                  : "No configured provider can enforce this parent's runtime mode.",
            }),
        providers: targetProviders,
        maxConcurrentPerParent: MAX_PER_PARENT,
        persistence: "durable",
        completionDelivery: "automatic-or-result",
      };
    }),
    spawn: Effect.fn("ChildRunService.spawn")(function* (scope, input) {
      return yield* start(scope, yield* parent(scope), input, null, null, 1);
    }),
    send: Effect.fn("ChildRunService.send")(function* (scope, input) {
      const run = yield* readOwned(scope, input.runId);
      const active = activeByRun.get(run.runId);
      if (active !== undefined && !isTerminal(run)) {
        yield* steerActive(active, input.prompt);
        return toResult({ ...run, status: "running" });
      }
      if (!isTerminal(run)) {
        return yield* new ChildRunError({ message: "Child run is not available in this process." });
      }
      return yield* start(
        scope,
        yield* parent(scope),
        {
          providerInstanceId: run.providerInstanceId,
          model: run.model,
          title: run.title,
          prompt: input.prompt,
        },
        run.runId,
        run.resumeCursor,
        run.generation + 1,
      );
    }),
    result: Effect.fn("ChildRunService.result")(function* (scope, runId, waitMs = 0) {
      let run = yield* readOwned(scope, runId);
      const active = activeByRun.get(run.runId);
      if (active !== undefined && waitMs > 0) {
        yield* Deferred.await(active.done).pipe(Effect.timeoutOption(Math.min(waitMs, 30_000)));
        run = yield* readOwned(scope, runId);
      }
      return toResult(run);
    }),
    cancel: Effect.fn("ChildRunService.cancel")(function* (scope, runId) {
      const run = yield* readOwned(scope, runId);
      const active = activeByRun.get(run.runId);
      if (active !== undefined) yield* Deferred.succeed(active.cancel, undefined);
      return toResult(run);
    }),
  });
});

export const layerWithRepository = Layer.effect(ChildRunService, make);

export const layer = layerWithRepository.pipe(Layer.provide(NativeChildRunRepositoryAuto));
