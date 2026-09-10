import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelections,
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
import {
  isOrchestrationCommandRejection,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import { NativeChildRunRepositoryAuto } from "../persistence/Layers/NativeChildRuns.ts";
import {
  NativeChildDeliveryBatch,
  NativeChildRunRepository,
  NativeChildMessage,
  NativeChildRun,
  NATIVE_CHILD_RESTART_ERROR,
  type NativeChildDeliveryBatchWithRuns,
} from "../persistence/Services/NativeChildRuns.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderSubagentControlPlaneShape,
} from "../provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export class ChildRunError extends Schema.TaggedErrorClass<ChildRunError>()("ChildRunError", {
  message: Schema.String,
}) {}

export const ChildRunSpawnInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  options: Schema.optionalKey(ProviderOptionSelections),
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
  agentId: RuntimeTaskId,
  generation: Schema.Int,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  title: Schema.String,
  requestedOptions: Schema.optional(ProviderOptionSelections),
  status: Schema.Literals(["starting", "running", "completed", "failed", "cancelled"]),
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  error: Schema.optional(Schema.String),
});
export type ChildRunResult = typeof ChildRunResult.Type;

export const AgentSendInput = Schema.Struct({
  messageId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  targetAgentId: RuntimeTaskId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
});
export type AgentSendInput = typeof AgentSendInput.Type;

export const AgentSendResult = Schema.Struct({
  messageId: Schema.String,
  senderAgentId: RuntimeTaskId,
  targetAgentId: RuntimeTaskId,
  status: Schema.Literals(["queued", "notified"]),
  deliveryRunId: RuntimeTaskId,
});
export type AgentSendResult = typeof AgentSendResult.Type;

export const AgentInboxInput = Schema.Struct({
  acknowledgeMessageIds: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(100))).check(
      Schema.isMaxLength(50),
    ),
  ),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type AgentInboxInput = typeof AgentInboxInput.Type;

export const AgentInboxResult = Schema.Struct({
  agentId: RuntimeTaskId,
  peers: Schema.Array(
    Schema.Struct({
      agentId: RuntimeTaskId,
      title: Schema.String,
      providerInstanceId: ProviderInstanceId,
      model: Schema.String,
      status: Schema.Literals(["starting", "running", "completed", "failed", "cancelled"]),
    }),
  ),
  peersTruncated: Schema.Boolean,
  messages: Schema.Array(
    Schema.Struct({
      messageId: Schema.String,
      senderAgentId: RuntimeTaskId,
      senderTitle: Schema.String,
      message: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  acknowledgedMessageIds: Schema.Array(Schema.String),
  hasMore: Schema.Boolean,
});
export type AgentInboxResult = typeof AgentInboxResult.Type;

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
      models: Schema.Array(
        Schema.Struct({
          model: TrimmedNonEmptyString,
          optionDescriptors: Schema.Array(ProviderOptionDescriptor),
        }),
      ),
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
  readonly ready: Deferred.Deferred<void>;
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
  credentialIssued: boolean;
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
const MAX_DELIVERY_TEXT = 100_000;
const MAX_DELIVERY_OUTPUT_PER_RUN = 4_000;
const MAX_DELIVERY_ERROR = 2_000;
const MAX_INBOX_MESSAGE_TEXT = 75_000;
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
const isPreviouslyRejected = Schema.is(OrchestrationCommandPreviouslyRejectedError);

function boundedDeliveryPart(text: string, limit: number, label: string): string {
  if (text.length <= limit) return text;
  const suffix = `\n[${label} truncated; call subagent_result for the full durable result]`;
  if (limit <= suffix.length) return suffix.slice(0, limit);
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function buildDeliveryBatchText(runs: ReadonlyArray<NativeChildRun>): {
  readonly runs: ReadonlyArray<NativeChildRun>;
  readonly text: string;
} {
  const grouped = new Map<RuntimeTaskId, NativeChildRun[]>();
  for (const run of runs) {
    const group = grouped.get(run.agentId);
    if (group === undefined) grouped.set(run.agentId, [run]);
    else group.push(run);
  }
  const prefix = [
    "[T3 subagent results]",
    "Completion notification: continue or synthesize the useful findings when they matter; do not echo individual child reports.",
  ];
  const maximumSummary = `Included ${runs.length} of ${runs.length} pending run${runs.length === 1 ? "" : "s"} from ${grouped.size} agent${grouped.size === 1 ? "" : "s"}. Remaining runs stay pending for a later notification.`;
  const metadata: string[] = [];
  const selected: NativeChildRun[] = [];
  let length = [...prefix, maximumSummary].join("\n").length;
  for (const [agentId, group] of grouped) {
    const heading = `Agent ${group[0]?.title ?? agentId} (${agentId})`;
    let headingAdded = false;
    for (const run of group) {
      const runParts = [`- Run ${run.runId}: ${run.status}; ${run.provider}/${run.model}`];
      if (run.error !== null) {
        runParts.push(
          `  Failure: ${boundedDeliveryPart(run.error, MAX_DELIVERY_ERROR, "failure")}`,
        );
      }
      const addition = `${headingAdded ? "" : `${heading}\n`}${runParts.join("\n")}\n`;
      if (length + addition.length > MAX_DELIVERY_TEXT) break;
      if (!headingAdded) metadata.push(heading);
      metadata.push(...runParts);
      selected.push(run);
      headingAdded = true;
      length += addition.length;
    }
  }
  const selectedAgentCount = new Set(selected.map((run) => run.agentId)).size;
  const summary = `Included ${selected.length} of ${runs.length} pending run${runs.length === 1 ? "" : "s"} from ${selectedAgentCount} agent${selectedAgentCount === 1 ? "" : "s"}.${selected.length < runs.length ? " Remaining runs stay pending for a later notification." : ""}`;
  let text = [...prefix, summary, ...metadata].join("\n");
  for (const run of selected) {
    if (run.output.length === 0) continue;
    const prefix = `\nOutput excerpt for run ${run.runId}:\n`;
    const remaining = MAX_DELIVERY_TEXT - text.length - prefix.length;
    if (remaining <= 100) break;
    const excerpt = boundedDeliveryPart(
      run.output,
      Math.min(MAX_DELIVERY_OUTPUT_PER_RUN, remaining),
      "output",
    );
    text += `${prefix}${excerpt}`;
    if (run.outputTruncated && text.length + 42 <= MAX_DELIVERY_TEXT) {
      text += "\n[provider output was already truncated]";
    }
  }
  return { runs: selected, text };
}

function nativeManagerId(threadId: ThreadId): string {
  return `t3-native:${NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32)}`;
}

function toResult(run: NativeChildRun): ChildRunResult {
  return {
    runId: run.runId,
    agentId: run.agentId,
    generation: run.generation,
    providerInstanceId: run.providerInstanceId,
    model: run.model,
    title: run.title,
    ...(run.requestedOptions === undefined ? {} : { requestedOptions: run.requestedOptions }),
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
      acknowledge?: boolean,
    ) => Effect.Effect<ChildRunResult, ChildRunError>;
    cancel: (
      scope: McpInvocationScope,
      runId: string,
    ) => Effect.Effect<ChildRunResult, ChildRunError>;
    agentSend: (
      scope: McpInvocationScope,
      input: AgentSendInput,
    ) => Effect.Effect<AgentSendResult, ChildRunError>;
    agentInbox: (
      scope: McpInvocationScope,
      input: AgentInboxInput,
    ) => Effect.Effect<AgentInboxResult, ChildRunError>;
    readonly controlPlane: ProviderSubagentControlPlaneShape<never>;
  }
>()("t3/mcp/ChildRunService") {}

export interface ChildRunMcpHooks {
  readonly issue: typeof McpSessionRegistry.issueActiveMcpCredential;
  readonly touch: typeof McpSessionRegistry.touchActiveMcpThread;
  readonly revoke: typeof McpSessionRegistry.revokeActiveMcpThread;
}

const liveMcpHooks: ChildRunMcpHooks = {
  issue: McpSessionRegistry.issueActiveMcpCredential,
  touch: McpSessionRegistry.touchActiveMcpThread,
  revoke: McpSessionRegistry.revokeActiveMcpThread,
};

/** Runs T3-native child agents and gives each child only sibling-messaging MCP access. */
const makeWithOptions = Effect.fn("ChildRunService.make")(function* (mcpHooks: ChildRunMcpHooks) {
  const registry = yield* ProviderAdapterRegistry;
  const providers = yield* ProviderService;
  const providerInstances = yield* ProviderInstanceRegistry;
  const repository = yield* NativeChildRunRepository;
  const engine = yield* OrchestrationEngineService;
  const startup = yield* ServerRuntimeStartup;
  const serviceScope = yield* Scope.Scope;
  const spawnMutex = yield* Semaphore.make(1);
  const activeByRun = new Map<RuntimeTaskId, ActiveRun>();
  const activeByThread = new Map<ThreadId, ActiveRun>();
  const stoppedParents = new Set<ThreadId>();
  const parentProviderByThread = new Map<ThreadId, ProviderInstanceId>();
  const activeByAgent = new Map<RuntimeTaskId, ActiveRun>();
  const deliveryMutexByAgent = new Map<RuntimeTaskId, Semaphore.Semaphore>();
  const deliveryMutexByParent = new Map<ThreadId, Semaphore.Semaphore>();
  const deliveryMutexRegistry = yield* Semaphore.make(1);

  const persistenceError = (operation: string) => (_cause: unknown) =>
    new ChildRunError({ message: `${operation} failed.` });

  const mutexForAgent = Effect.fn("ChildRunService.mutexForAgent")(function* (
    agentId: RuntimeTaskId,
  ) {
    const existing = deliveryMutexByAgent.get(agentId);
    if (existing !== undefined) return existing;
    return yield* Effect.gen(function* () {
      const current = deliveryMutexByAgent.get(agentId);
      if (current !== undefined) return current;
      const created = yield* Semaphore.make(1);
      deliveryMutexByAgent.set(agentId, created);
      return created;
    }).pipe(deliveryMutexRegistry.withPermits(1));
  });

  const mutexForParent = Effect.fn("ChildRunService.mutexForParent")(function* (
    parentThreadId: ThreadId,
  ) {
    const existing = deliveryMutexByParent.get(parentThreadId);
    if (existing !== undefined) return existing;
    return yield* Effect.gen(function* () {
      const current = deliveryMutexByParent.get(parentThreadId);
      if (current !== undefined) return current;
      const created = yield* Semaphore.make(1);
      deliveryMutexByParent.set(parentThreadId, created);
      return created;
    }).pipe(deliveryMutexRegistry.withPermits(1));
  });

  const validateOptions = Effect.fn("ChildRunService.validateOptions")(function* (
    providerInstanceId: ProviderInstanceId,
    model: string,
    options: ProviderOptionSelections | undefined,
  ) {
    if (options === undefined || options.length === 0) return;
    const instance = yield* providerInstances.getInstance(providerInstanceId);
    const snapshot = instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
    const modelInfo = snapshot?.models.find((candidate) => candidate.slug === model);
    if (modelInfo === undefined) {
      return yield* new ChildRunError({
        message: `Model '${model}' is not advertised by provider instance '${providerInstanceId}'.`,
      });
    }
    const descriptors = modelInfo.capabilities?.optionDescriptors ?? [];
    const seen = new Set<string>();
    for (const selection of options) {
      if (seen.has(selection.id)) {
        return yield* new ChildRunError({
          message: `Option '${selection.id}' was provided more than once for model '${model}'.`,
        });
      }
      seen.add(selection.id);
      const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
      if (descriptor === undefined) {
        return yield* new ChildRunError({
          message: `Unsupported option '${selection.id}' for model '${model}'. Supported options: ${descriptors.map((candidate) => candidate.id).join(", ") || "none"}.`,
        });
      }
      if (descriptor.type === "select") {
        if (typeof selection.value !== "string") {
          return yield* new ChildRunError({
            message: `Option '${selection.id}' for model '${model}' requires one of: ${descriptor.options.map((candidate) => candidate.id).join(", ") || "none"}.`,
          });
        }
        if (!descriptor.options.some((candidate) => candidate.id === selection.value)) {
          return yield* new ChildRunError({
            message: `Unsupported value '${selection.value}' for option '${selection.id}' on model '${model}'. Supported values: ${descriptor.options.map((candidate) => candidate.id).join(", ") || "none"}.`,
          });
        }
      } else if (typeof selection.value !== "boolean") {
        return yield* new ChildRunError({
          message: `Option '${selection.id}' for model '${model}' requires a boolean value.`,
        });
      }
    }
  });

  const modelSelectionForRun = (run: NativeChildRun) => ({
    instanceId: run.providerInstanceId,
    model: run.model,
    ...(run.requestedOptions === undefined ? {} : { options: run.requestedOptions }),
  });

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

  const dispatchDeliveryBatchOnce = Effect.fn("ChildRunService.dispatchDeliveryBatchOnce")(
    function* (delivery: NativeChildDeliveryBatchWithRuns) {
      const { batch } = delivery;
      if (stoppedParents.has(batch.parentThreadId)) {
        yield* repository
          .markParentDelivered(batch.parentThreadId)
          .pipe(Effect.mapError(persistenceError("Suppressing delivery after parent stop")));
        return "suppressed" as const;
      }
      const parentState = yield* engine.getAutomaticTurnState(batch.parentThreadId);
      if (parentState === null) return "uncertain" as const;
      const dispatchedAt = yield* nowIso;
      const outcome = yield* startup
        .enqueueCommand(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(batch.commandId),
            threadId: batch.parentThreadId,
            message: {
              messageId: MessageId.make(batch.messageId),
              role: "user",
              text: batch.text,
              attachments: [],
              origin: "subagent-delivery",
            },
            runtimeMode: parentState.runtimeMode,
            interactionMode: "default",
            onlyIfIdle: true,
            createdAt: dispatchedAt,
          }),
        )
        .pipe(Effect.result);
      if (outcome._tag === "Success") {
        yield* repository
          .markDeliveryBatchDelivered({ batchId: batch.batchId, updatedAt: dispatchedAt })
          .pipe(Effect.mapError(persistenceError("Recording child result delivery")));
        return "delivered" as const;
      }
      const error = outcome.failure;
      if (isOrchestrationCommandRejection(error) || isPreviouslyRejected(error)) {
        yield* repository
          .markDeliveryBatchRejected({ batchId: batch.batchId, updatedAt: dispatchedAt })
          .pipe(Effect.mapError(persistenceError("Recording rejected child result delivery")));
        return "rejected" as const;
      }
      return "uncertain" as const;
    },
  );

  const dispatchDeliveryBatch = Effect.fn("ChildRunService.dispatchDeliveryBatch")(function* (
    delivery: NativeChildDeliveryBatchWithRuns,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = yield* dispatchDeliveryBatchOnce(delivery);
      if (outcome !== "uncertain") return outcome;
      yield* Effect.yieldNow;
    }
    return "uncertain" as const;
  });

  const deliverPendingForParent = Effect.fn("ChildRunService.deliverPendingForParent")(function* (
    parentThreadId: ThreadId,
  ) {
    const open = yield* repository
      .getOpenDeliveryBatch(parentThreadId)
      .pipe(Effect.mapError(persistenceError("Reading prepared child result delivery")));
    if (open !== null) return yield* dispatchDeliveryBatch(open);
    if (stoppedParents.has(parentThreadId)) return "suppressed" as const;
    const pending = yield* repository.listPendingDelivery(parentThreadId).pipe(
      Effect.map((runs) => runs.filter((run) => run.deliveryState === "pending")),
      Effect.mapError(persistenceError("Listing pending child results")),
    );
    if (pending.length === 0) return "empty" as const;
    const parentState = yield* engine.getAutomaticTurnState(parentThreadId);
    if (parentState === null || !parentState.canStart) return "busy" as const;
    const delivery = buildDeliveryBatchText(pending);
    const createdAt = yield* nowIso;
    const batchId = `native-child-batch:${NodeCrypto.randomUUID()}`;
    const batch = NativeChildDeliveryBatch.make({
      batchId,
      parentThreadId,
      runtimeMode: parentState.runtimeMode,
      text: delivery.text,
      commandId: `server:native-child-delivery:${batchId}`,
      messageId: `native-child-delivery:${batchId}`,
      state: "prepared",
      createdAt,
      updatedAt: createdAt,
    });
    const inserted = yield* repository
      .insertDeliveryBatch({
        batch,
        runIds: delivery.runs.map((run) => run.runId),
      })
      .pipe(Effect.mapError(persistenceError("Preparing child result delivery")));
    if (!inserted) return "empty" as const;
    return yield* dispatchDeliveryBatch({ batch, runs: delivery.runs });
  });

  const deliverPending = Effect.fn("ChildRunService.deliverPending")(function* (
    parentThreadId?: ThreadId,
  ) {
    const parents =
      parentThreadId === undefined
        ? [
            ...new Set(
              (yield* repository.listPendingDelivery().pipe(
                Effect.map((runs) => runs.filter((run) => run.deliveryState === "pending")),
                Effect.mapError(persistenceError("Listing pending child results")),
              )).map((run) => run.parentThreadId),
            ),
          ]
        : [parentThreadId];
    yield* Effect.forEach(
      parents,
      (threadId) =>
        Effect.gen(function* () {
          const mutex = yield* mutexForParent(threadId);
          yield* deliverPendingForParent(threadId).pipe(mutex.withPermits(1));
        }),
      { concurrency: "unbounded", discard: true },
    );
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
    yield* clearChildCredential(active);
    yield* clearActive(active);
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
        yield* deliverPending(stored.parentThreadId);
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
      ready: yield* Deferred.make<void>(),
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
      credentialIssued: false,
      pendingSteers: 0,
      pendingCompletions: [],
    };
    activeByRun.set(run.runId, active);
    activeByThread.set(run.childThreadId, active);
    activeByAgent.set(run.agentId, active);
    yield* mutexForAgent(run.agentId);
    return active;
  });

  const clearActive = (active: ActiveRun) =>
    Effect.sync(() => {
      activeByRun.delete(active.run.runId);
      activeByThread.delete(active.run.childThreadId);
      if (activeByAgent.get(active.run.agentId) === active)
        activeByAgent.delete(active.run.agentId);
    });

  const clearChildCredential = Effect.fn("ChildRunService.clearChildCredential")(function* (
    active: ActiveRun,
  ) {
    if (!active.credentialIssued) return;
    active.credentialIssued = false;
    yield* mcpHooks.revoke(active.run.childThreadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Child MCP credential cleanup failed", {
          childThreadId: active.run.childThreadId,
          cause,
        }),
      ),
    );
    yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(active.run.childThreadId));
  });

  const execute = Effect.fn("ChildRunService.execute")(function* (
    active: ActiveRun,
    prompt: string,
  ) {
    const { run, adapter } = active;
    const work = Effect.gen(function* () {
      const credential = yield* mcpHooks.issue({
        threadId: run.childThreadId,
        providerInstanceId: run.providerInstanceId,
        capabilities: ["messaging"],
        agentMessaging: { agentId: run.agentId, parentThreadId: run.parentThreadId },
      });
      if (credential === undefined) {
        return yield* new ChildRunError({ message: "The child messaging server is not ready." });
      }
      active.credentialIssued = true;
      yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config));
      const session = yield* adapter.startSession({
        threadId: run.childThreadId,
        providerInstanceId: run.providerInstanceId,
        cwd: run.cwd,
        title: run.title,
        runtimeMode: run.runtimeMode,
        voiceNotifications: false,
        modelSelection: modelSelectionForRun(run),
        ...(run.resumeCursor === null ? {} : { resumeCursor: run.resumeCursor }),
      });
      active.sessionStarted = true;
      active.resumeCursor = session.resumeCursor ?? active.resumeCursor;
      yield* mcpHooks.touch(run.childThreadId);
      const turn = yield* adapter.sendTurn({
        threadId: run.childThreadId,
        input: `${prompt}\n\n[T3 agent messaging]\nYour stable agent ID is ${run.agentId}. Teammates in this parent thread can send messages with agent_send. Use agent_inbox to list teammate addresses, read pending messages, and explicitly acknowledge processed message IDs.`,
        modelSelection: modelSelectionForRun(run),
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
      yield* Deferred.succeed(active.ready, undefined);
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
          yield* clearChildCredential(active);
          yield* clearActive(active);
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
          modelSelection: modelSelectionForRun(active.run),
        })
        .pipe(Effect.mapError(() => new ChildRunError({ message: "Child steering failed." })));
      yield* mcpHooks.touch(active.run.childThreadId);
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
      session: Pick<ProviderSession, "cwd" | "runtimeMode">,
      input: ChildRunSpawnInput,
      parentRunId: RuntimeTaskId | null,
      resumeCursor: unknown | null,
      generation: number,
      agentId: RuntimeTaskId | null,
    ) {
      if (session.cwd === undefined) {
        return yield* new ChildRunError({ message: "Parent session has no working directory." });
      }
      const info = yield* registry
        .getInstanceInfo(input.providerInstanceId)
        .pipe(Effect.mapError(() => new ChildRunError({ message: "Unknown provider instance." })));
      const availability = providerAvailability(info.driverKind, session.runtimeMode);
      if (!info.enabled || !availability.available) {
        return yield* new ChildRunError({
          message: availability.reason ?? "Provider instance is disabled.",
        });
      }
      yield* validateOptions(input.providerInstanceId, input.model, input.options);
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
        agentId: agentId ?? RuntimeTaskId.make(`native-agent-${id}`),
        runNumber,
        parentRunId,
        parentThreadId: scope.threadId,
        childThreadId,
        providerInstanceId: input.providerInstanceId,
        provider: info.driverKind,
        model: input.model,
        title: input.title,
        ...(input.options === undefined ? {} : { requestedOptions: input.options }),
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
              clearActive(active).pipe(Effect.andThen(Deferred.succeed(active.done, undefined))),
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
                clearActive(active).pipe(Effect.andThen(Deferred.succeed(active.done, undefined))),
              ),
              Effect.andThen(Effect.fail(cause)),
            ),
        ),
      );
      yield* execute(active, input.prompt).pipe(
        Effect.onError((cause) =>
          Effect.logError("Native child execution failed", { runId: run.runId, cause }),
        ),
        Effect.ensuring(clearActive(active)),
        Effect.interruptible,
        Effect.forkIn(serviceScope, { startImmediately: true }),
      );
      return toResult(run);
    },
    spawnMutex.withPermits(1),
    Effect.uninterruptible,
  );

  const requireMessagingAgent = Effect.fn("ChildRunService.requireMessagingAgent")(function* (
    scope: McpInvocationScope,
  ) {
    const binding = scope.agentMessaging;
    if (
      scope.capabilities.size !== 1 ||
      !scope.capabilities.has("messaging") ||
      binding === undefined
    ) {
      return yield* new ChildRunError({
        message: "This MCP credential has no native child messaging capability.",
      });
    }
    const run = yield* repository
      .getByChildThread(scope.threadId)
      .pipe(Effect.mapError(persistenceError("Reading the sending child")));
    if (
      run === null ||
      run.agentId !== binding.agentId ||
      run.parentThreadId !== binding.parentThreadId ||
      (run.status !== "starting" && run.status !== "running") ||
      stoppedParents.has(run.parentThreadId)
    ) {
      return yield* new ChildRunError({ message: "This child messaging session is inactive." });
    }
    return run;
  });

  const messagePrompt = (sender: NativeChildRun, message: NativeChildMessage) =>
    `[T3 agent message ${message.messageId} from ${sender.title} (${sender.agentId})]\n${message.body}\n\nRead pending messages and acknowledge this message after processing it with agent_inbox.`;

  const notifyRecipient = Effect.fn("ChildRunService.notifyRecipient")(function* (
    scope: McpInvocationScope,
    sender: NativeChildRun,
    persisted: NativeChildMessage,
  ) {
    if (persisted.deliveryState === "notified" && persisted.deliveryRunId !== null) {
      return persisted;
    }
    let target = yield* repository
      .getLatestByAgent(persisted.recipientAgentId)
      .pipe(Effect.mapError(persistenceError("Reading the target child")));
    if (target === null || target.parentThreadId !== sender.parentThreadId) {
      return yield* new ChildRunError({ message: "Unknown target agent in this team." });
    }
    if (stoppedParents.has(target.parentThreadId)) {
      return yield* new ChildRunError({ message: "The parent session has stopped." });
    }

    let active = activeByAgent.get(target.agentId);
    if (active !== undefined && !active.sessionStopped) {
      const state = yield* Effect.raceFirst(
        Deferred.await(active.ready).pipe(Effect.as("ready" as const)),
        Deferred.await(active.done).pipe(Effect.as("done" as const)),
      );
      const terminalDone = yield* Deferred.isDone(active.terminal);
      if (
        state === "ready" &&
        !active.sessionStopped &&
        activeByAgent.get(target.agentId) === active &&
        !terminalDone
      ) {
        yield* steerActive(active, messagePrompt(sender, persisted));
        const updatedAt = yield* nowIso;
        yield* repository
          .markMessageNotified({
            parentThreadId: persisted.parentThreadId,
            messageId: persisted.messageId,
            deliveryRunId: active.run.runId,
            updatedAt,
          })
          .pipe(Effect.mapError(persistenceError("Recording the child message notice")));
        return {
          ...persisted,
          deliveryState: "notified" as const,
          deliveryRunId: active.run.runId,
        };
      }
      if (terminalDone || active.sessionStopped || state === "done") {
        yield* Deferred.await(active.done);
      }
      target = yield* repository
        .getLatestByAgent(persisted.recipientAgentId)
        .pipe(Effect.mapError(persistenceError("Refreshing the target child")));
      active = target === null ? undefined : activeByAgent.get(target.agentId);
    }

    if (target === null || target.parentThreadId !== sender.parentThreadId) {
      return yield* new ChildRunError({ message: "Unknown target agent in this team." });
    }
    if (active !== undefined || target.status === "starting" || target.status === "running") {
      return yield* new ChildRunError({ message: "The target child is unavailable." });
    }
    if (target.status !== "completed") {
      return yield* new ChildRunError({
        message: "Cancelled or failed child agents cannot be restarted by a peer.",
      });
    }
    const parentProviderInstanceId = parentProviderByThread.get(target.parentThreadId);
    if (parentProviderInstanceId === undefined) {
      return yield* new ChildRunError({ message: "The parent session is no longer active." });
    }
    const parentScope: McpInvocationScope = {
      environmentId: scope.environmentId,
      threadId: target.parentThreadId,
      providerSessionId: scope.providerSessionId,
      providerInstanceId: parentProviderInstanceId,
      capabilities: new Set(["delegation"]),
      issuedAt: scope.issuedAt,
    };
    const liveParent = yield* parent(parentScope);
    const resumed = yield* start(
      parentScope,
      liveParent,
      {
        providerInstanceId: target.providerInstanceId,
        model: target.model,
        title: target.title,
        ...(target.requestedOptions === undefined ? {} : { options: target.requestedOptions }),
        prompt: messagePrompt(sender, persisted),
      },
      target.runId,
      target.resumeCursor,
      target.generation + 1,
      target.agentId,
    );
    const updatedAt = yield* nowIso;
    yield* repository
      .markMessageNotified({
        parentThreadId: persisted.parentThreadId,
        messageId: persisted.messageId,
        deliveryRunId: resumed.runId,
        updatedAt,
      })
      .pipe(Effect.mapError(persistenceError("Recording the resumed child message notice")));
    return { ...persisted, deliveryState: "notified" as const, deliveryRunId: resumed.runId };
  });

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
      const mutex = yield* mutexForParent(threadId);
      yield* Effect.gen(function* () {
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
      }).pipe(mutex.withPermits(1));
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
        const instance = yield* providerInstances.getInstance(id);
        const snapshot = instance === undefined ? undefined : yield* instance.snapshot.getSnapshot;
        targetProviders.push({
          providerInstanceId: id,
          driver: info.value.driverKind,
          ...(info.value.displayName === undefined ? {} : { displayName: info.value.displayName }),
          ...availability,
          models:
            snapshot?.models.map((model) => ({
              model: model.slug,
              optionDescriptors: model.capabilities?.optionDescriptors ?? [],
            })) ?? [],
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
      const session = yield* parent(scope);
      parentProviderByThread.set(scope.threadId, scope.providerInstanceId);
      stoppedParents.delete(scope.threadId);
      return yield* start(scope, session, input, null, null, 1, null);
    }),
    send: Effect.fn("ChildRunService.send")(function* (scope, input) {
      const run = yield* readOwned(scope, input.runId);
      parentProviderByThread.set(scope.threadId, scope.providerInstanceId);
      stoppedParents.delete(scope.threadId);
      const active = activeByRun.get(run.runId);
      if (active !== undefined && !isTerminal(run)) {
        yield* steerActive(active, input.prompt);
        return toResult({ ...run, status: "running" });
      }
      if (!isTerminal(run)) {
        return yield* new ChildRunError({
          message: "Child run is not available in this process.",
        });
      }
      const targetMutex = yield* mutexForAgent(run.agentId);
      return yield* Effect.gen(function* () {
        const latest = yield* repository
          .getLatestByAgent(run.agentId)
          .pipe(Effect.mapError(persistenceError("Reading the latest child generation")));
        if (latest === null || latest.parentThreadId !== scope.threadId) {
          return yield* new ChildRunError({ message: "Unknown child run for this thread." });
        }
        const latestActive = activeByAgent.get(latest.agentId);
        if (latestActive !== undefined && !latestActive.sessionStopped) {
          yield* steerActive(latestActive, input.prompt);
          return toResult({ ...latest, status: "running" });
        }
        if (!isTerminal(latest)) {
          return yield* new ChildRunError({
            message: "Child run is not available in this process.",
          });
        }
        return yield* start(
          scope,
          yield* parent(scope),
          {
            providerInstanceId: latest.providerInstanceId,
            model: latest.model,
            title: latest.title,
            ...(latest.requestedOptions === undefined ? {} : { options: latest.requestedOptions }),
            prompt: input.prompt,
          },
          latest.runId,
          latest.resumeCursor,
          latest.generation + 1,
          latest.agentId,
        );
      }).pipe(targetMutex.withPermits(1));
    }),
    agentSend: Effect.fn("ChildRunService.agentSend")(function* (scope, input) {
      const sender = yield* requireMessagingAgent(scope);
      if (input.targetAgentId === sender.agentId) {
        return yield* new ChildRunError({
          message: "Send messages to a teammate, not yourself.",
        });
      }
      const target = yield* repository
        .getLatestByAgent(input.targetAgentId)
        .pipe(Effect.mapError(persistenceError("Reading the target child")));
      if (target === null || target.parentThreadId !== sender.parentThreadId) {
        return yield* new ChildRunError({ message: "Unknown target agent in this team." });
      }
      if (target.status === "failed" || target.status === "cancelled") {
        return yield* new ChildRunError({
          message: "Cancelled or failed child agents cannot be restarted by a peer.",
        });
      }
      const createdAt = yield* nowIso;
      const inserted = yield* repository
        .insertMessage(
          NativeChildMessage.make({
            messageId: input.messageId,
            parentThreadId: sender.parentThreadId,
            senderAgentId: sender.agentId,
            recipientAgentId: target.agentId,
            body: input.message,
            deliveryState: "queued",
            deliveryRunId: null,
            createdAt,
            updatedAt: createdAt,
            acknowledgedAt: null,
          }),
        )
        .pipe(Effect.mapError(persistenceError("Persisting the child message")));
      if (inserted.status === "conflict") {
        return yield* new ChildRunError({
          message: "This messageId was already used for different content.",
        });
      }
      if (inserted.status === "inbox-full") {
        return yield* new ChildRunError({
          message: "The target inbox has 100 pending messages. Wait for acknowledgements.",
        });
      }
      const targetMutex = yield* mutexForAgent(target.agentId);
      const message = yield* notifyRecipient(scope, sender, inserted.message).pipe(
        targetMutex.withPermits(1),
      );
      if (message.deliveryRunId === null) {
        return yield* new ChildRunError({
          message: "The child message notice was not recorded.",
        });
      }
      return {
        messageId: message.messageId,
        senderAgentId: sender.agentId,
        targetAgentId: target.agentId,
        status: message.deliveryState,
        deliveryRunId: message.deliveryRunId,
      };
    }),
    agentInbox: Effect.fn("ChildRunService.agentInbox")(function* (scope, input) {
      const agent = yield* requireMessagingAgent(scope);
      const acknowledgedMessageIds: string[] = [];
      for (const messageId of new Set(input.acknowledgeMessageIds ?? [])) {
        const acknowledged = yield* repository
          .acknowledgeMessage({
            parentThreadId: agent.parentThreadId,
            recipientAgentId: agent.agentId,
            messageId,
            acknowledgedAt: yield* nowIso,
          })
          .pipe(Effect.mapError(persistenceError("Acknowledging the child message")));
        if (acknowledged) acknowledgedMessageIds.push(messageId);
      }
      const limit = input.limit ?? 50;
      const pending = yield* repository
        .listPendingMessages(agent.agentId, limit + 1)
        .pipe(Effect.mapError(persistenceError("Reading the child inbox")));
      const team = yield* repository
        .listLatestByParent(agent.parentThreadId, 52)
        .pipe(Effect.mapError(persistenceError("Listing child teammates")));
      const titles = new Map(team.map((peer) => [peer.agentId, peer.title] as const));
      const messages: Array<AgentInboxResult["messages"][number]> = [];
      let messageTextLength = 0;
      for (const message of pending.slice(0, limit)) {
        const senderTitle = titles.get(message.senderAgentId) ?? "Unknown teammate";
        const entryLength =
          message.messageId.length +
          message.senderAgentId.length +
          senderTitle.length +
          message.body.length +
          message.createdAt.length;
        if (messageTextLength + entryLength > MAX_INBOX_MESSAGE_TEXT) break;
        messageTextLength += entryLength;
        messages.push({
          messageId: message.messageId,
          senderAgentId: message.senderAgentId,
          senderTitle,
          message: message.body,
          createdAt: message.createdAt,
        });
      }
      return {
        agentId: agent.agentId,
        peers: team
          .filter((peer) => peer.agentId !== agent.agentId)
          .slice(0, 50)
          .map((peer) => ({
            agentId: peer.agentId,
            title: peer.title,
            providerInstanceId: peer.providerInstanceId,
            model: peer.model,
            status: peer.status,
          })),
        peersTruncated: team.filter((peer) => peer.agentId !== agent.agentId).length > 50,
        messages,
        acknowledgedMessageIds,
        hasMore: pending.length > messages.length,
      };
    }),
    result: Effect.fn("ChildRunService.result")(function* (
      scope,
      runId,
      waitMs = 0,
      acknowledge = false,
    ) {
      let run = yield* readOwned(scope, runId);
      const active = activeByRun.get(run.runId);
      if (active !== undefined && waitMs > 0) {
        yield* Deferred.await(active.done).pipe(Effect.timeoutOption(Math.min(waitMs, 30_000)));
        run = yield* readOwned(scope, runId);
      }
      if (acknowledge && isTerminal(run)) {
        const mutex = yield* mutexForParent(run.parentThreadId);
        yield* Effect.gen(function* () {
          const open = yield* repository
            .getOpenDeliveryBatch(run.parentThreadId)
            .pipe(Effect.mapError(persistenceError("Reading prepared child result delivery")));
          if (open?.runs.some((member) => member.runId === run.runId)) {
            return yield* new ChildRunError({
              message:
                "Automatic child result delivery may already be in flight; acknowledgement was not recorded.",
            });
          }
          yield* repository
            .acknowledgeTerminal(run.runId)
            .pipe(Effect.mapError(persistenceError("Acknowledging the child result")));
        }).pipe(mutex.withPermits(1));
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

export const layerWithRepositoryAndMcpHooks = (mcpHooks: ChildRunMcpHooks) =>
  Layer.effect(ChildRunService, makeWithOptions(mcpHooks));

export const layerWithRepository = Layer.effect(ChildRunService, makeWithOptions(liveMcpHooks));

export const layer = layerWithRepository.pipe(Layer.provide(NativeChildRunRepositoryAuto));
