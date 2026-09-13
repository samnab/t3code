import { expect, it } from "@effect/vitest";
import {
  CheckpointRef,
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  RuntimeItemId,
  RuntimeTaskId,
  SubagentRunEvidence,
  type ServerProvider,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type RuntimeMode,
  type ThreadGoalLoop,
} from "@t3tools/contracts";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationListenerCallbackError,
} from "../orchestration/Errors.ts";
import { NativeChildRunRepositoryAuto } from "../persistence/Layers/NativeChildRuns.ts";
import { ProjectionSubagentRunRepositoryLive } from "../persistence/Layers/ProjectionSubagentRuns.ts";
import { ProjectionSubagentTranscriptStoreLive } from "../persistence/Layers/ProjectionSubagentTranscripts.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  NativeChildDeliveryBatch,
  NativeChildRun,
  NativeChildRunRepository,
} from "../persistence/Services/NativeChildRuns.ts";
import { ProjectionSubagentRunRepository } from "../persistence/Services/ProjectionSubagentRuns.ts";
import {
  ProjectionSubagentTranscriptStore,
  type ReadSubagentTranscriptPageResult,
} from "../persistence/Services/ProjectionSubagentTranscripts.ts";
import { ProviderAdapterValidationError, type ProviderAdapterError } from "../provider/Errors.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import {
  ChildRunResult,
  ChildRunService,
  layerWithRepositoryAndMcpHooks,
} from "./ChildRunService.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import type { McpCredentialRequest } from "./McpSessionRegistry.ts";
import { DelegationToolkitRegistrationLive } from "./McpHttpServer.ts";
import { clearMcpProviderSession, readMcpProviderSession } from "./McpProviderSession.ts";

const now = "2026-09-06T00:00:00.000Z";
const parentId = ThreadId.make("parent");
const otherParentId = ThreadId.make("other-parent");
const decodeChildRunResult = Schema.decodeUnknownEffect(ChildRunResult);
const NativeActivityPayload = Schema.Struct({ subagentRun: SubagentRunEvidence });
const decodeNativeActivityPayload = Schema.decodeUnknownEffect(NativeActivityPayload);
const decodeNativeActivityPayloadSync = Schema.decodeUnknownSync(NativeActivityPayload);
const noopTranscriptStore = ProjectionSubagentTranscriptStore.of({
  signalStartCommitted: () => Effect.void,
  awaitStartCommitted: () => Effect.succeed(true),
  ingestItem: (input) =>
    Effect.succeed({ outcome: "stored", watermark: input.item.transcriptSequence }),
  ingestNativeItem: (input) =>
    Effect.succeed({ outcome: "stored", watermark: input.item.transcriptSequence }),
  getWatermark: () => Effect.succeed(0),
  readWatermarks: () => Effect.succeed([]),
  readWatermarksForManager: () => Effect.succeed([]),
  readPage: () => Effect.succeed({ unavailable: "unavailable" }),
});
const makeHarness = Effect.fn("makeHarness")(function* (
  parentDriver = "codex",
  childDriver = "claudeAgent",
  mode: RuntimeMode = "full-access",
  complete = true,
  failFirstActivity = false,
  repositoryLayer?: Layer.Layer<NativeChildRunRepository>,
  pauseTerminalActivity = false,
  blockSteers = false,
  childOptionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>,
  secondChildDriver?: string,
  deliveryControl?: {
    idle: boolean;
    goalLoop?: ThreadGoalLoop | null;
    outcomes?: Array<"success" | "accepted" | "busy" | "uncertain" | "uncertain-after-accept">;
    acceptedCommandIds?: Set<string>;
    attempts?: OrchestrationCommand[];
  },
  transcriptControl?: {
    readonly store: ProjectionSubagentTranscriptStore["Service"];
    readonly projectActivity?: (command: OrchestrationCommand) => Effect.Effect<void>;
  },
) {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
  const backgroundLiveness = ThreadBackgroundLiveness.make();
  const sent = yield* Deferred.make<ThreadId>();
  const terminalActivityReached = yield* Deferred.make<void>();
  const releaseTerminalActivity = yield* Deferred.make<void>();
  const firstSteerStarted = yield* Deferred.make<void>();
  const releaseFirstSteer = yield* Deferred.make<void>();
  const secondSteerStarted = yield* Deferred.make<void>();
  const releaseSecondSteer = yield* Deferred.make<void>();
  const starts: Array<ProviderSessionStartInput> = [];
  const stopped: Array<ThreadId> = [];
  const sentPrompts: string[] = [];
  const sentSelections: Array<ProviderSendTurnInput["modelSelection"]> = [];
  const sentTurns: TurnId[] = [];
  const commands: OrchestrationCommand[] = [];
  const credentialRequests: McpCredentialRequest[] = [];
  const touchedCredentials: ThreadId[] = [];
  const revokedCredentials: ThreadId[] = [];
  let shouldFailActivity = failFirstActivity;
  let firstTurnIssue: string | undefined;
  const parentInstance = ProviderInstanceId.make("parent-provider");
  const childInstance = ProviderInstanceId.make("child-provider");
  const secondChildInstance = ProviderInstanceId.make("second-child-provider");
  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment"),
    threadId: parentId,
    providerSessionId: "parent-session",
    providerInstanceId: parentInstance,
    capabilities: new Set(["delegation"]),
    issuedAt: 0,
  };
  const parentSession: ProviderSession = {
    provider: ProviderDriverKind.make(parentDriver),
    providerInstanceId: parentInstance,
    threadId: parentId,
    runtimeMode: mode,
    status: "running",
    cwd: "/workspace",
    createdAt: now,
    updatedAt: now,
  };
  let parentRuntimeMode = mode;
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: ProviderDriverKind.make(childDriver),
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) =>
      Effect.sync(() => {
        starts.push(input);
        expect(readMcpProviderSession(input.threadId)?.endpoint).toBe("http://127.0.0.1/mcp/agent");
        return {
          ...parentSession,
          provider: ProviderDriverKind.make(childDriver),
          threadId: input.threadId,
          resumeCursor: { session: "native-session" },
        };
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
        if (firstTurnIssue !== undefined) {
          const issue = firstTurnIssue;
          firstTurnIssue = undefined;
          return yield* new ProviderAdapterValidationError({
            provider: ProviderDriverKind.make(childDriver),
            operation: "sendTurn",
            issue,
          });
        }
        const turnNumber = sentTurns.length + 1;
        const turnId = TurnId.make(`child-turn-${turnNumber}`);
        sentTurns.push(turnId);
        sentPrompts.push(input.input ?? "");
        sentSelections.push(input.modelSelection);
        yield* Deferred.succeed(sent, input.threadId);
        if (blockSteers && turnNumber === 2) {
          yield* Deferred.succeed(firstSteerStarted, undefined);
          yield* Deferred.await(releaseFirstSteer);
        }
        if (blockSteers && turnNumber === 3) {
          yield* Deferred.succeed(secondSteerStarted, undefined);
          yield* Deferred.await(releaseSecondSteer);
        }
        if (complete) {
          yield* PubSub.publish(events, {
            type: "content.delta",
            eventId: EventId.make("text"),
            provider: ProviderDriverKind.make(childDriver),
            threadId: input.threadId,
            turnId,
            createdAt: now,
            payload: { streamKind: "assistant_text", delta: "Native child result" },
          });
          yield* PubSub.publish(events, {
            type: "turn.completed",
            eventId: EventId.make("complete"),
            provider: ProviderDriverKind.make(childDriver),
            threadId: input.threadId,
            turnId,
            createdAt: now,
            payload: { state: "completed" },
          });
        }
        return { threadId: input.threadId, turnId, resumeCursor: { session: "native-session" } };
      }),
    stopSession: (id) =>
      Effect.sync(() => {
        stopped.push(id);
      }),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopAll: () => Effect.void,
    listSessions: () =>
      Effect.succeed([
        { ...parentSession, runtimeMode: parentRuntimeMode },
        { ...parentSession, threadId: otherParentId, runtimeMode: parentRuntimeMode },
      ]),
    hasSession: () => Effect.succeed(true),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    streamEvents: Stream.die("ChildRunService must consume ProviderService's canonical stream"),
  };
  const secondAdapter: ProviderAdapterShape<ProviderAdapterError> = {
    ...adapter,
    provider: ProviderDriverKind.make(secondChildDriver ?? childDriver),
  };
  const changes = yield* PubSub.unbounded<void>();
  const registry = ProviderAdapterRegistry.of({
    getByInstance: (instanceId) =>
      Effect.succeed(instanceId === secondChildInstance ? secondAdapter : adapter),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(
          instanceId === childInstance
            ? childDriver
            : instanceId === secondChildInstance
              ? (secondChildDriver ?? childDriver)
              : parentDriver,
        ),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(childDriver),
          continuationKey: "test",
        },
      }),
    listInstances: () =>
      Effect.succeed(
        secondChildDriver === undefined ? [childInstance] : [childInstance, secondChildInstance],
      ),
    subscribeChanges: PubSub.subscribe(changes),
  });
  const childProvider =
    childOptionDescriptors === undefined
      ? undefined
      : {
          instanceId: childInstance,
          driverKind: ProviderDriverKind.make(childDriver),
          continuationIdentity: {
            driverKind: ProviderDriverKind.make(childDriver),
            continuationKey: "test",
          },
          displayName: undefined,
          enabled: true,
          snapshot: {
            resolveMaintenance: () => Effect.die("unused"),
            getSnapshot: Effect.succeed({
              instanceId: childInstance,
              driver: ProviderDriverKind.make(childDriver),
              enabled: true,
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: now,
              models: [
                {
                  slug: "native-model",
                  name: "Native model",
                  isCustom: false,
                  capabilities:
                    childOptionDescriptors.length === 0
                      ? null
                      : { optionDescriptors: childOptionDescriptors },
                },
              ],
              slashCommands: [],
              skills: [],
            } satisfies ServerProvider),
            refresh: Effect.die("unused"),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.void,
          },
          adapter,
          textGeneration: {
            generateCommitMessage: () => Effect.die("unused"),
            generatePrContent: () => Effect.die("unused"),
            generateBranchName: () => Effect.die("unused"),
            generateThreadTitle: () => Effect.die("unused"),
          },
        };
  const providerInstanceRegistry = {
    getInstance: (instanceId: ProviderInstanceId) =>
      Effect.succeed(instanceId === childInstance ? childProvider : undefined),
    listInstances: Effect.succeed(childProvider === undefined ? [] : [childProvider]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  };
  const runtimeServices = Layer.mergeAll(
    Layer.succeed(ThreadBackgroundLiveness.ThreadBackgroundLivenessService, backgroundLiveness),
    Layer.mock(ProviderService)({ streamEvents: Stream.fromPubSub(events) }),
    Layer.mock(OrchestrationEngineService)({
      getAutomaticTurnState: () =>
        Effect.sync(() => ({
          runtimeMode: parentRuntimeMode,
          canStart: deliveryControl?.idle !== false,
          goalLoop: deliveryControl?.goalLoop ?? null,
        })),
      dispatch: (command) =>
        Effect.suspend(
          (): Effect.Effect<
            { readonly sequence: number },
            OrchestrationCommandInvariantError | OrchestrationListenerCallbackError
          > => {
            const projectActivity = transcriptControl?.projectActivity;
            if (projectActivity !== undefined && command.type === "thread.activity.append") {
              return Effect.gen(function* () {
                yield* projectActivity(command);
                commands.push(command);
                return { sequence: commands.length };
              });
            }
            if (shouldFailActivity && command.type === "thread.activity.append") {
              shouldFailActivity = false;
              return Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "simulated activity rejection",
                }),
              );
            }
            if (command.type === "thread.turn.start") {
              deliveryControl?.attempts?.push(command);
              if (deliveryControl?.acceptedCommandIds?.has(command.commandId)) {
                return Effect.succeed({ sequence: commands.length });
              }
              const outcome = deliveryControl?.outcomes?.shift() ?? "success";
              if (outcome === "busy") {
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "simulated idle-check race",
                  }),
                );
              }
              if (outcome === "accepted") {
                commands.push(command);
                deliveryControl?.acceptedCommandIds?.add(command.commandId);
                return Effect.succeed({ sequence: commands.length });
              }
              if (outcome === "uncertain-after-accept") {
                commands.push(command);
                deliveryControl?.acceptedCommandIds?.add(command.commandId);
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "simulated uncertain accepted dispatch",
                  }),
                );
              }
              if (outcome === "uncertain") {
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "simulated uncertain dispatch",
                  }),
                );
              }
            }
            return Effect.gen(function* () {
              if (
                pauseTerminalActivity &&
                command.type === "thread.activity.append" &&
                command.activity.kind === "task.completed"
              ) {
                yield* Deferred.succeed(terminalActivityReached, undefined);
                yield* Deferred.await(releaseTerminalActivity);
              }
              commands.push(command);
              return { sequence: commands.length };
            });
          },
        ),
      subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(domainEvents)),
    }),
    Layer.mock(ServerRuntimeStartup)({
      awaitCommandReady: Effect.void,
      enqueueCommand: (effect) => effect,
    }),
    Layer.succeed(ProviderInstanceRegistry, providerInstanceRegistry),
  );
  const mcpHooks = {
    issue: (request: McpCredentialRequest) =>
      Effect.sync(() => {
        credentialRequests.push(request);
        return {
          config: {
            environmentId: scope.environmentId,
            threadId: request.threadId,
            providerSessionId: `mcp-${request.threadId}`,
            providerInstanceId: request.providerInstanceId,
            endpoint: "http://127.0.0.1/mcp/agent",
            authorizationHeader: "Bearer test-child-token",
            capabilities: new Set(request.capabilities ?? []),
          },
        };
      }),
    touch: (threadId: ThreadId) =>
      Effect.sync(() => {
        touchedCredentials.push(threadId);
      }),
    revoke: (threadId: ThreadId) =>
      Effect.sync(() => {
        revokedCredentials.push(threadId);
        clearMcpProviderSession(threadId);
      }),
  };
  const childLayer = layerWithRepositoryAndMcpHooks(mcpHooks).pipe(
    Layer.provide(repositoryLayer ?? NativeChildRunRepositoryAuto),
    Layer.provide(
      Layer.succeed(
        ProjectionSubagentTranscriptStore,
        transcriptControl?.store ?? noopTranscriptStore,
      ),
    ),
  );
  return {
    scope,
    starts,
    stopped,
    sentPrompts,
    sentSelections,
    sentTurns,
    credentialRequests,
    touchedCredentials,
    revokedCredentials,
    setParentRuntimeMode: (runtimeMode: RuntimeMode) => {
      parentRuntimeMode = runtimeMode;
    },
    failFirstTurn: (issue: string) => {
      firstTurnIssue = issue;
    },
    commands,
    backgroundLiveness,
    sent,
    events,
    domainEvents,
    terminalActivityReached,
    releaseTerminalActivity,
    firstSteerStarted,
    releaseFirstSteer,
    secondSteerStarted,
    releaseSecondSteer,
    input: {
      providerInstanceId: childInstance,
      model: "native-model",
      title: "Investigate",
      prompt: "Do the task",
    },
    secondInput: {
      providerInstanceId: secondChildInstance,
      model: "second-native-model",
      title: "Coordinate",
      prompt: "Wait for a teammate",
    },
    services: childLayer.pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(runtimeServices),
    ),
  };
});

const messagingScope = (
  parentScope: McpInvocationScope,
  request: McpCredentialRequest,
): McpInvocationScope => {
  if (request.agentMessaging === undefined) throw new Error("missing agent messaging binding");
  return {
    environmentId: parentScope.environmentId,
    threadId: request.threadId,
    providerSessionId: `mcp-${request.threadId}`,
    providerInstanceId: request.providerInstanceId,
    capabilities: new Set(["messaging"]),
    agentMessaging: request.agentMessaging,
    issuedAt: 0,
  };
};

const seedTerminalRun = Effect.fn("seedTerminalRun")(function* (
  repository: NativeChildRunRepository["Service"],
  input: {
    readonly runId: string;
    readonly agentId: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly output?: string;
    readonly error?: string;
    readonly createdAt?: string;
  },
) {
  const runId = RuntimeTaskId.make(input.runId);
  const childThreadId = ThreadId.make(`child-${input.runId}`);
  const createdAt = input.createdAt ?? now;
  const runNumber = yield* repository.reserveRunNumber({
    runId,
    childThreadId,
    allocatedAt: createdAt,
  });
  yield* repository.insert(
    NativeChildRun.make({
      runId,
      agentId: RuntimeTaskId.make(input.agentId),
      runNumber,
      parentRunId: null,
      parentThreadId: parentId,
      childThreadId,
      providerInstanceId: ProviderInstanceId.make("child-provider"),
      provider: ProviderDriverKind.make("claudeAgent"),
      model: "native-model",
      title: `Agent ${input.agentId}`,
      runtimeMode: "full-access",
      cwd: "/workspace",
      resumeCursor: null,
      generation: 1,
      status: input.status,
      output: input.output ?? "",
      outputTruncated: false,
      error: input.error ?? null,
      deliveryState: "pending",
      deliveryAttempt: 0,
      createdAt,
      updatedAt: createdAt,
    }),
  );
});

const publishParentTurnDiff = (events: PubSub.PubSub<OrchestrationEvent>, suffix: string) =>
  PubSub.publish(events, {
    sequence: 1,
    eventId: EventId.make(`parent-turn-diff-${suffix}`),
    aggregateKind: "thread" as const,
    aggregateId: parentId,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-diff-completed" as const,
    payload: {
      threadId: parentId,
      turnId: TurnId.make(`parent-turn-${suffix}`),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/parent/${suffix}`),
      status: "ready" as const,
      files: [],
      assistantMessageId: null,
      completedAt: now,
    },
  });

const makeDeliveryHarness = (
  repository: NativeChildRunRepository["Service"],
  deliveryControl: {
    idle: boolean;
    goalLoop?: ThreadGoalLoop | null;
    outcomes?: Array<"success" | "accepted" | "busy" | "uncertain" | "uncertain-after-accept">;
    acceptedCommandIds?: Set<string>;
    attempts?: OrchestrationCommand[];
  },
) =>
  makeHarness(
    "codex",
    "claudeAgent",
    "full-access",
    false,
    false,
    Layer.succeed(NativeChildRunRepository, repository),
    false,
    false,
    undefined,
    undefined,
    deliveryControl,
  );

it.effect("batches every pending child completion into one parent turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const repository = Context.get(repositoryContext, NativeChildRunRepository);
      for (let index = 0; index < 42; index++) {
        yield* seedTerminalRun(repository, {
          runId: `pending-run-${index}`,
          agentId: `agent-${index % 3}`,
          status: index === 7 ? "failed" : "completed",
          output: `output-${index}-${"x".repeat(100_000)}`,
          ...(index === 7 ? { error: "failed-seven" } : {}),
          createdAt: `2026-09-06T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
      }
      const h = yield* makeHarness(
        "codex",
        "claudeAgent",
        "full-access",
        false,
        false,
        Layer.succeed(NativeChildRunRepository, repository),
      );
      yield* Effect.gen(function* () {
        yield* ChildRunService;
        yield* Effect.forEach([1, 2], () => Effect.yieldNow, { discard: true });
        const deliveries = h.commands.filter((command) => command.type === "thread.turn.start");
        expect(deliveries).toHaveLength(1);
        const delivery = deliveries[0];
        if (delivery?.type !== "thread.turn.start") throw new Error("missing delivery");
        expect(delivery.message.text.length).toBeLessThanOrEqual(100_000);
        for (let index = 0; index < 42; index++) {
          expect(delivery.message.text).toContain(`pending-run-${index}`);
        }
        expect(delivery.message.text).toContain("failed-seven");
        expect(delivery.message.text.match(/^Agent Agent agent-/gm) ?? []).toHaveLength(3);
      }).pipe(Effect.provide(h.services));
    }),
  ),
);

it.effect(
  "acknowledges only terminal pending results while ordinary and running reads stay live",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositoryScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
        const repositoryContext = yield* Layer.buildWithScope(
          NativeChildRunRepositoryAuto,
          repositoryScope,
        );
        const repository = Context.get(repositoryContext, NativeChildRunRepository);
        yield* seedTerminalRun(repository, {
          runId: "read-only-terminal",
          agentId: "read-only-agent",
          status: "completed",
          output: "keep notification",
        });
        yield* seedTerminalRun(repository, {
          runId: "acknowledged-terminal",
          agentId: "acknowledged-agent",
          status: "completed",
          output: "suppress notification",
        });
        const deliveryControl = { idle: false };
        const h = yield* makeDeliveryHarness(repository, deliveryControl);
        yield* Effect.gen(function* () {
          const service = yield* ChildRunService;
          yield* service.result(h.scope, "read-only-terminal");
          yield* service.result(h.scope, "acknowledged-terminal", 0, true);
          expect(
            (yield* repository.get(RuntimeTaskId.make("read-only-terminal")))?.deliveryState,
          ).toBe("pending");
          expect(
            (yield* repository.get(RuntimeTaskId.make("acknowledged-terminal")))?.deliveryState,
          ).toBe("suppressed");

          const running = yield* service.spawn(h.scope, h.input);
          const childThreadId = yield* Deferred.await(h.sent);
          expect((yield* service.result(h.scope, running.runId, 0, true)).status).toBe("running");
          yield* PubSub.publish(h.events, {
            type: "turn.completed",
            eventId: EventId.make("ack-running-completed"),
            provider: ProviderDriverKind.make("claudeAgent"),
            threadId: childThreadId,
            turnId: h.sentTurns[0],
            createdAt: now,
            payload: { state: "completed" },
          });
          expect((yield* service.result(h.scope, running.runId, 30_000)).status).toBe("completed");

          deliveryControl.idle = true;
          yield* publishParentTurnDiff(h.domainEvents, "ack-semantics");
          yield* Effect.yieldNow;
          const deliveries = h.commands.filter((command) => command.type === "thread.turn.start");
          expect(deliveries).toHaveLength(1);
          const delivery = deliveries[0];
          if (delivery?.type !== "thread.turn.start") throw new Error("missing delivery");
          expect(delivery.message.text).toContain("read-only-terminal");
          expect(delivery.message.text).toContain(running.runId);
          expect(delivery.message.text).not.toContain("acknowledged-terminal");
        }).pipe(Effect.provide(h.services));
      }),
    ),
);

it.effect("delivers a held goal's pending child result once the goal resumes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const repository = Context.get(repositoryContext, NativeChildRunRepository);
      yield* seedTerminalRun(repository, {
        runId: "held-goal-result",
        agentId: "held-goal-agent",
        status: "completed",
        output: "Required result",
      });
      const pausedLoop: ThreadGoalLoop = {
        kind: "standard",
        state: "paused",
        mode: "t3",
        iterations: 2,
        maxIterations: 10,
        reason: null,
        experiment: null,
        updatedAt: now,
      };
      const deliveryControl: {
        idle: boolean;
        goalLoop: ThreadGoalLoop | null;
      } = {
        idle: false,
        goalLoop: pausedLoop,
      };
      const h = yield* makeDeliveryHarness(repository, deliveryControl);
      yield* Effect.gen(function* () {
        yield* ChildRunService;
        yield* Effect.yieldNow;
        expect(h.commands.filter((command) => command.type === "thread.turn.start")).toEqual([]);

        const resumedAt = "2026-09-06T00:01:00.000Z";
        deliveryControl.idle = true;
        deliveryControl.goalLoop = {
          ...pausedLoop,
          state: "idle",
          updatedAt: resumedAt,
        };
        const resumedEvent: OrchestrationEvent = {
          sequence: 2,
          eventId: EventId.make("held-goal-resumed"),
          aggregateKind: "thread",
          aggregateId: parentId,
          occurredAt: resumedAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.goal-loop-updated",
          payload: {
            threadId: parentId,
            loop: deliveryControl.goalLoop,
            resumed: true,
          },
        };
        yield* PubSub.publish(h.domainEvents, resumedEvent);
        yield* Effect.yieldNow;

        const deliveries = h.commands.filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
            command.type === "thread.turn.start",
        );
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.message.origin).toBe("subagent-delivery");
        expect(deliveries[0]?.continuation).toBe(true);
        expect(deliveries[0]?.goalLoopGuard).toEqual({ updatedAt: resumedAt });

        yield* PubSub.publish(h.domainEvents, resumedEvent);
        yield* Effect.yieldNow;
        expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          1,
        );
      }).pipe(Effect.provide(h.services));
    }),
  ),
);

it.effect("lets acknowledgement suppress a result after an idle-check dispatch race", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const repository = Context.get(repositoryContext, NativeChildRunRepository);
      yield* seedTerminalRun(repository, {
        runId: "busy-race-run",
        agentId: "busy-race-agent",
        status: "failed",
        error: "race failure",
      });
      const deliveryControl = {
        idle: true,
        outcomes: ["busy" as const],
        attempts: [] as OrchestrationCommand[],
      };
      const h = yield* makeDeliveryHarness(repository, deliveryControl);
      yield* Effect.gen(function* () {
        const service = yield* ChildRunService;
        expect(deliveryControl.attempts).toHaveLength(1);
        expect((yield* repository.get(RuntimeTaskId.make("busy-race-run")))?.deliveryAttempt).toBe(
          1,
        );
        yield* service.result(h.scope, "busy-race-run", 0, true);
        expect((yield* repository.get(RuntimeTaskId.make("busy-race-run")))?.deliveryState).toBe(
          "suppressed",
        );
        yield* publishParentTurnDiff(h.domainEvents, "busy-race");
        yield* Effect.yieldNow;
        expect(deliveryControl.attempts).toHaveLength(1);
      }).pipe(Effect.provide(h.services));
    }),
  ),
);

it.effect("reuses durable batch identities across uncertain dispatch and service restart", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const repository = Context.get(repositoryContext, NativeChildRunRepository);
      yield* seedTerminalRun(repository, {
        runId: "restart-delivery-run",
        agentId: "restart-delivery-agent",
        status: "completed",
        output: "restart result",
      });
      const attempts: OrchestrationCommand[] = [];
      const firstControl = {
        idle: true,
        outcomes: ["uncertain" as const, "uncertain" as const, "uncertain" as const],
        attempts,
      };
      const firstHarness = yield* makeDeliveryHarness(repository, firstControl);
      const firstScope = yield* Scope.make();
      yield* Layer.buildWithScope(firstHarness.services, firstScope);
      yield* Effect.forEach([1, 2, 3, 4], () => Effect.yieldNow, { discard: true });
      expect(attempts).toHaveLength(3);
      const prepared = yield* repository.getOpenDeliveryBatch(parentId);
      expect(prepared).not.toBeNull();
      yield* Scope.close(firstScope, Exit.void);
      yield* TestClock.adjust("1 second");

      const secondControl = { idle: true, attempts };
      const secondHarness = yield* makeDeliveryHarness(repository, secondControl);
      secondHarness.setParentRuntimeMode("approval-required");
      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      yield* Layer.buildWithScope(secondHarness.services, secondScope);
      yield* Effect.forEach([1, 2], () => Effect.yieldNow, { discard: true });
      expect(attempts).toHaveLength(4);
      const deliveryAttempts = attempts.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
          command.type === "thread.turn.start",
      );
      expect(new Set(deliveryAttempts.map((command) => command.commandId)).size).toBe(1);
      expect(new Set(deliveryAttempts.map((command) => command.message.messageId)).size).toBe(1);
      expect(new Set(deliveryAttempts.map((command) => command.message.text)).size).toBe(1);
      expect(deliveryAttempts[3]?.runtimeMode).toBe("approval-required");
      expect(deliveryAttempts[3]?.createdAt).not.toBe(deliveryAttempts[0]?.createdAt);
      expect(
        (yield* repository.get(RuntimeTaskId.make("restart-delivery-run")))?.deliveryState,
      ).toBe("delivered");
    }),
  ),
);

it.effect("replays an accepted prepared delivery while the recovered parent is busy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const repository = Context.get(repositoryContext, NativeChildRunRepository);
      yield* seedTerminalRun(repository, {
        runId: "accepted-prepared-run",
        agentId: "accepted-prepared-agent",
        status: "completed",
        output: "accepted before restart",
      });
      const commandId = "server:native-child-delivery:accepted-prepared-batch";
      yield* repository.insertDeliveryBatch({
        batch: NativeChildDeliveryBatch.make({
          batchId: "accepted-prepared-batch",
          parentThreadId: parentId,
          runtimeMode: "full-access",
          text: "Accepted child result",
          commandId,
          messageId: "native-child-delivery:accepted-prepared-batch",
          state: "prepared",
          createdAt: now,
          updatedAt: now,
        }),
        runIds: [RuntimeTaskId.make("accepted-prepared-run")],
      });
      const attempts: OrchestrationCommand[] = [];
      const h = yield* makeDeliveryHarness(repository, {
        idle: false,
        attempts,
        acceptedCommandIds: new Set([commandId]),
      });
      yield* Effect.gen(function* () {
        yield* ChildRunService;
        yield* Effect.forEach([1, 2], () => Effect.yieldNow, { discard: true });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.commandId).toBe(commandId);
        expect(
          (yield* repository.get(RuntimeTaskId.make("accepted-prepared-run")))?.deliveryState,
        ).toBe("delivered");
        expect(yield* repository.getOpenDeliveryBatch(parentId)).toBeNull();
      }).pipe(Effect.provide(h.services));
    }),
  ),
);

it.effect("reconciles an accepted uncertain dispatch without creating a duplicate turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const repository = Context.get(repositoryContext, NativeChildRunRepository);
      yield* seedTerminalRun(repository, {
        runId: "accepted-uncertain-run",
        agentId: "accepted-uncertain-agent",
        status: "completed",
      });
      const attempts: OrchestrationCommand[] = [];
      const deliveryControl = {
        idle: true,
        outcomes: ["uncertain-after-accept" as const],
        attempts,
        acceptedCommandIds: new Set<string>(),
      };
      const h = yield* makeDeliveryHarness(repository, deliveryControl);
      yield* Effect.gen(function* () {
        yield* ChildRunService;
        yield* Effect.forEach([1, 2], () => Effect.yieldNow, { discard: true });
        expect(attempts).toHaveLength(2);
        expect(attempts[0]?.commandId).toBe(attempts[1]?.commandId);
        expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          1,
        );
        expect(
          (yield* repository.get(RuntimeTaskId.make("accepted-uncertain-run")))?.deliveryState,
        ).toBe("delivered");
      }).pipe(Effect.provide(h.services));
    }),
  ),
);

it.effect("recovers an accepted delivery when recording completion fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const baseRepository = Context.get(repositoryContext, NativeChildRunRepository);
      yield* seedTerminalRun(baseRepository, {
        runId: "accepted-recording-failure",
        agentId: "accepted-recording-agent",
        status: "completed",
      });
      let failRecording = true;
      const failingRepository = NativeChildRunRepository.of({
        ...baseRepository,
        markDeliveryBatchDelivered: (input) => {
          if (!failRecording) return baseRepository.markDeliveryBatchDelivered(input);
          failRecording = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "test.markDeliveryBatchDelivered",
              detail: "simulated recording failure",
            }),
          );
        },
      });
      const attempts: OrchestrationCommand[] = [];
      const acceptedCommandIds = new Set<string>();
      const firstHarness = yield* makeDeliveryHarness(failingRepository, {
        idle: true,
        outcomes: ["accepted"],
        attempts,
        acceptedCommandIds,
      });
      const firstScope = yield* Scope.make();
      yield* Layer.buildWithScope(firstHarness.services, firstScope);
      yield* Effect.forEach([1, 2], () => Effect.yieldNow, { discard: true });
      expect((yield* baseRepository.getOpenDeliveryBatch(parentId))?.batch.state).toBe("prepared");
      yield* Scope.close(firstScope, Exit.void);

      const secondHarness = yield* makeDeliveryHarness(baseRepository, {
        idle: true,
        attempts,
        acceptedCommandIds,
      });
      const secondScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
      yield* Layer.buildWithScope(secondHarness.services, secondScope);
      yield* Effect.forEach([1, 2], () => Effect.yieldNow, { discard: true });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.commandId).toBe(attempts[1]?.commandId);
      expect(
        (yield* baseRepository.get(RuntimeTaskId.make("accepted-recording-failure")))
          ?.deliveryState,
      ).toBe("delivered");
      expect(
        firstHarness.commands.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(1);
      expect(
        secondHarness.commands.filter((command) => command.type === "thread.turn.start"),
      ).toHaveLength(0);
    }),
  ),
);

for (const [parentDriver, childDriver] of [
  ["codex", "claudeAgent"],
  ["claudeAgent", "codex"],
  ["pi", "codex"],
  ["codex", "pi"],
]) {
  it.effect(
    `${parentDriver} delegates directly to ${childDriver} and collects immediate completion`,
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(parentDriver, childDriver);
        yield* Effect.gen(function* () {
          const service = yield* ChildRunService;
          const capabilities = yield* service.capabilities(h.scope);
          expect(capabilities.available).toBe(true);
          expect(capabilities.providers[0]?.driver).toBe(childDriver);
          const run = yield* service.spawn(h.scope, h.input);
          yield* Deferred.await(h.sent);
          const result = yield* service.result(h.scope, run.runId, 30_000);
          expect(result.status).toBe("completed");
          expect(result.output).toBe("Native child result");
          expect(h.starts).toHaveLength(1);
          expect(h.starts[0]?.threadId).not.toBe(parentId);
          expect(h.starts[0]?.cwd).toBe("/workspace");
          expect(h.starts[0]?.modelSelection).toEqual({
            instanceId: h.input.providerInstanceId,
            model: "native-model",
          });
          expect(h.stopped).toEqual([h.starts[0]?.threadId]);
          expect(h.credentialRequests).toEqual([
            {
              threadId: h.starts[0]?.threadId,
              providerInstanceId: h.input.providerInstanceId,
              capabilities: ["messaging"],
              agentMessaging: { agentId: run.agentId, parentThreadId: parentId },
            },
          ]);
          expect(h.revokedCredentials).toEqual([h.starts[0]?.threadId]);
          const deliveryCommands = h.commands.filter(
            (command) => command.type === "thread.turn.start",
          );
          expect(deliveryCommands).toHaveLength(1);
          expect(
            deliveryCommands[0]?.type === "thread.turn.start" && deliveryCommands[0].message.origin,
          ).toBe("subagent-delivery");
        }).pipe(Effect.provide(h.services));
      }),
  );
}

it.effect(
  "persists the complete native child transcript before terminal projection and delivery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const infrastructureScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(infrastructureScope, Exit.void));
        const infrastructure = yield* Layer.buildWithScope(
          Layer.mergeAll(
            NativeChildRunRepositoryAuto,
            ProjectionSubagentRunRepositoryLive,
            ProjectionSubagentTranscriptStoreLive,
          ).pipe(Layer.provide(SqlitePersistenceMemory)),
          infrastructureScope,
        );
        const repository = Context.get(infrastructure, NativeChildRunRepository);
        const projectionRuns = Context.get(infrastructure, ProjectionSubagentRunRepository);
        const transcriptStore = Context.get(infrastructure, ProjectionSubagentTranscriptStore);
        const terminalPages = new Map<RuntimeTaskId, ReadSubagentTranscriptPageResult["entries"]>();
        let eventSequence = 0;
        const projectActivity = (command: OrchestrationCommand): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (command.type !== "thread.activity.append") return;
            const { subagentRun: evidence } = yield* decodeNativeActivityPayload(
              command.activity.payload,
            );
            eventSequence += 1;
            if (command.activity.kind === "task.started") {
              if (evidence.runNumber === undefined) throw new Error("missing native run number");
              yield* projectionRuns.insertStart({
                runId: evidence.runId,
                runNumber: evidence.runNumber,
                threadId: command.threadId,
                parentRunId: evidence.parentRunId ?? null,
                runtimeFamily: evidence.runtimeFamily,
                harness: evidence.harness ?? null,
                provider: evidence.provider,
                providerInstanceId: evidence.providerInstanceId ?? null,
                model: "native-model",
                effort: null,
                title: "Coordinate",
                summary: null,
                status: evidence.status,
                terminalReason: evidence.terminalReason ?? null,
                controlAvailability: evidence.controlAvailability,
                historyAvailability: evidence.historyAvailability,
                capabilities: evidence.capabilities,
                createdAt: evidence.startedAt,
                updatedAt: command.activity.createdAt,
                terminalAt: null,
                runBirth: evidence.runBirth ?? null,
                ownerId: null,
                ownerEpoch: "reserved",
                nativeRunId: null,
                activationId: null,
                firstEventSequence: eventSequence,
                lastEventSequence: eventSequence,
              });
              yield* transcriptStore.signalStartCommitted({ runId: evidence.runId });
              return;
            }
            const page = yield* transcriptStore.readPage({
              threadId: command.threadId,
              runId: evidence.runId,
            });
            if (!("unavailable" in page)) terminalPages.set(evidence.runId, page.entries);
            yield* projectionRuns.updateLifecycle({
              runId: evidence.runId,
              status: evidence.status,
              terminalReason: evidence.terminalReason ?? null,
              title: "Coordinate",
              model: "native-model",
              effort: null,
              summary: command.activity.summary,
              updatedAt: command.activity.createdAt,
              eventSequence,
            });
          }).pipe(Effect.orDie);
        const h = yield* makeHarness(
          "codex",
          "pi",
          "full-access",
          false,
          false,
          Layer.succeed(NativeChildRunRepository, repository),
          false,
          false,
          undefined,
          undefined,
          undefined,
          { store: transcriptStore, projectActivity },
        );

        yield* Effect.gen(function* () {
          const service = yield* ChildRunService;
          const receiver = yield* service.spawn(h.scope, h.input);
          const receiverThreadId = h.starts[0]!.threadId;
          const sender = yield* service.spawn(h.scope, h.secondInput);

          const publish = (event: ProviderRuntimeEvent) => PubSub.publish(h.events, event);
          const assistantOne = RuntimeItemId.make("assistant-one");
          yield* publish({
            type: "content.delta",
            eventId: EventId.make("assistant-one-a"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: assistantOne,
            createdAt: now,
            payload: { streamKind: "assistant_text", delta: "First " },
          });
          yield* publish({
            type: "content.delta",
            eventId: EventId.make("assistant-one-b"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: assistantOne,
            createdAt: now,
            payload: { streamKind: "assistant_text", delta: "update" },
          });
          yield* publish({
            type: "item.completed",
            eventId: EventId.make("assistant-one-complete"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: assistantOne,
            createdAt: now,
            payload: {
              itemType: "assistant_message",
              status: "completed",
              detail: "First update",
            },
          });
          const reasoning = RuntimeItemId.make("reasoning-one");
          yield* publish({
            type: "content.delta",
            eventId: EventId.make("reasoning-delta"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: reasoning,
            createdAt: now,
            payload: { streamKind: "reasoning_text", delta: "Check the durable path" },
          });
          yield* publish({
            type: "item.completed",
            eventId: EventId.make("reasoning-complete"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: reasoning,
            createdAt: now,
            payload: {
              itemType: "reasoning",
              status: "completed",
              detail: "Check the durable path",
            },
          });
          const tool = RuntimeItemId.make("tool-one");
          yield* publish({
            type: "item.started",
            eventId: EventId.make("tool-started"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: tool,
            createdAt: now,
            payload: {
              itemType: "mcp_tool_call",
              status: "inProgress",
              title: "read_file",
              data: { path: "README.md" },
            },
          });
          yield* publish({
            type: "content.delta",
            eventId: EventId.make("tool-output"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: tool,
            createdAt: now,
            payload: { streamKind: "command_output", delta: "permission denied" },
          });
          yield* publish({
            type: "item.completed",
            eventId: EventId.make("tool-completed"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: tool,
            createdAt: now,
            payload: {
              itemType: "mcp_tool_call",
              status: "failed",
              title: "read_file",
              detail: "permission denied",
            },
          });
          yield* publish({
            type: "task.progress",
            eventId: EventId.make("progress"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            createdAt: now,
            payload: {
              taskId: receiver.runId,
              description: "Retrying with another source",
              summary: "The first tool failed",
            },
          });

          const beforeSteer = RuntimeItemId.make("assistant-before-steer");
          yield* publish({
            type: "content.delta",
            eventId: EventId.make("assistant-before-steer-delta"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: beforeSteer,
            createdAt: now,
            payload: { streamKind: "assistant_text", delta: "Output before steer" },
          });
          yield* service.send(h.scope, { runId: receiver.runId, prompt: "Parent follow-up" });
          const nativeStatus = (yield* service.controlPlane.status())[0];
          if (
            nativeStatus === undefined ||
            !nativeStatus.supported ||
            nativeStatus.managerId === undefined
          ) {
            throw new Error("missing native control status");
          }
          yield* service.controlPlane.steer({
            managerId: nativeStatus.managerId,
            runId: receiver.runId,
            text: "Parent steering",
          });
          const senderCredential = h.credentialRequests.find(
            (request) => request.agentMessaging?.agentId === sender.agentId,
          );
          if (senderCredential === undefined) throw new Error("missing sender credential");
          yield* service.agentSend(messagingScope(h.scope, senderCredential), {
            messageId: "sibling-message",
            targetAgentId: receiver.agentId,
            message: "Sibling evidence",
          });
          yield* publish({
            type: "item.completed",
            eventId: EventId.make("assistant-before-steer-complete"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: h.sentTurns[0],
            itemId: beforeSteer,
            createdAt: now,
            payload: {
              itemType: "assistant_message",
              status: "completed",
              detail: "Output before steer",
            },
          });

          const finalAssistant = RuntimeItemId.make("assistant-final");
          const finalTurnId = h.sentTurns.at(-1)!;
          yield* publish({
            type: "content.delta",
            eventId: EventId.make("assistant-final-delta"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: finalTurnId,
            itemId: finalAssistant,
            createdAt: now,
            payload: { streamKind: "assistant_text", delta: "Final child report" },
          });
          yield* publish({
            type: "item.completed",
            eventId: EventId.make("assistant-final-complete"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: finalTurnId,
            itemId: finalAssistant,
            createdAt: now,
            payload: {
              itemType: "assistant_message",
              status: "completed",
              detail: "Final child report",
            },
          });
          yield* publish({
            type: "turn.completed",
            eventId: EventId.make("receiver-completed"),
            provider: ProviderDriverKind.make("pi"),
            threadId: receiverThreadId,
            turnId: finalTurnId,
            createdAt: now,
            payload: { state: "completed" },
          });
          expect((yield* service.result(h.scope, receiver.runId, 30_000)).status).toBe("completed");

          const page = yield* transcriptStore.readPage({
            threadId: parentId,
            runId: receiver.runId,
          });
          if ("unavailable" in page) throw new Error(`transcript unavailable: ${page.unavailable}`);
          expect(page.entries.map((entry) => ("text" in entry ? entry.text : ""))).toEqual([
            "Do the task",
            "First update",
            "[Reasoning]\nCheck the durable path",
            '[Tool call: read_file]\n{\n  "path": "README.md"\n}',
            "[Command output]\npermission denied",
            "[Tool result: read_file (failed)]\npermission denied",
            "[Progress: Retrying with another source]\nThe first tool failed",
            "Output before steer",
            "Parent follow-up",
            "Parent steering",
            `[T3 agent message sibling-message from Coordinate (${sender.agentId})]\nSibling evidence\n\nRead pending messages and acknowledge this message after processing it with agent_inbox.`,
            "Final child report",
            "[Run completed]",
          ]);
          const siblingEntry = page.entries[10];
          if (siblingEntry === undefined || !("text" in siblingEntry)) {
            throw new Error("missing sibling transcript entry");
          }
          expect(siblingEntry.text).toContain(`from Coordinate (${sender.agentId})`);
          const terminalEntry = terminalPages.get(receiver.runId)?.at(-1);
          expect(
            terminalEntry !== undefined && "text" in terminalEntry ? terminalEntry.text : null,
          ).toBe("[Run completed]");
          const deliveries = h.commands.filter(
            (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
              command.type === "thread.turn.start",
          );
          expect(deliveries).toHaveLength(1);
          expect(deliveries[0]!.message.text).toContain("Final child report");

          const senderThreadId = h.starts[1]!.threadId;
          yield* publish({
            type: "runtime.error",
            eventId: EventId.make("sender-runtime-error"),
            provider: ProviderDriverKind.make("pi"),
            threadId: senderThreadId,
            turnId: h.sentTurns[1],
            createdAt: now,
            payload: { message: "Provider transport failed", class: "transport_error" },
          });
          expect((yield* service.result(h.scope, sender.runId, 30_000)).error).toContain(
            "Provider transport failed",
          );
          const failedPage = yield* transcriptStore.readPage({
            threadId: parentId,
            runId: sender.runId,
          });
          if ("unavailable" in failedPage) throw new Error("failed transcript unavailable");
          expect(
            failedPage.entries.map((entry) => ("text" in entry ? entry.text : "")).at(-1),
          ).toContain("Provider transport failed");
        }).pipe(Effect.provide(h.services));
      }),
    ),
);

it.effect("denies other parents and callers without delegation capability", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      for (const scope of [
        { ...h.scope, threadId: ThreadId.make("other-parent") },
        { ...h.scope, capabilities: new Set<"preview">(["preview"]) },
      ]) {
        const outcome = yield* service.result(scope, run.runId).pipe(Effect.result);
        expect(outcome._tag).toBe("Failure");
      }
      expect(
        (yield* service.result({ ...h.scope, providerSessionId: "replacement-session" }, run.runId))
          .runId,
      ).toBe(run.runId);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("surfaces adapter validation failures on the child terminal error", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    h.failFirstTurn("Pi model zai/glm-5 is at its max concurrent turns (1).");
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      const result = yield* service.result(h.scope, run.runId, 30_000);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("max concurrent turns");
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("validates, reports, and preserves fixed child model options", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      "codex",
      "claudeAgent",
      "full-access",
      true,
      false,
      undefined,
      false,
      false,
      [
        {
          id: "thinking",
          label: "Thinking",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
          ],
        },
      ],
    );
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const input = {
        ...h.input,
        options: [{ id: "thinking", value: "medium" }],
      };
      const capabilities = yield* service.capabilities(h.scope);
      expect(capabilities.providers[0]?.models).toEqual([
        {
          model: "native-model",
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
              ],
            },
          ],
        },
      ]);
      const run = yield* service.spawn(h.scope, input);
      expect(h.starts[0]?.modelSelection).toEqual({
        instanceId: h.input.providerInstanceId,
        model: h.input.model,
        options: input.options,
      });
      expect(h.sentSelections[0]).toEqual(h.starts[0]?.modelSelection);
      const result = yield* service.result(h.scope, run.runId, 30_000);
      expect(result.requestedOptions).toEqual(input.options);

      const followup = yield* service.send(h.scope, {
        runId: run.runId,
        prompt: "Keep the same reasoning level",
      });
      expect(h.starts[1]?.modelSelection).toEqual(h.starts[0]?.modelSelection);
      expect(h.sentSelections[1]).toEqual(h.starts[0]?.modelSelection);
      expect((yield* service.result(h.scope, followup.runId, 30_000)).requestedOptions).toEqual(
        input.options,
      );
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("rejects unknown, unsupported, and duplicate child options before launch", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      "codex",
      "claudeAgent",
      "full-access",
      true,
      false,
      undefined,
      false,
      false,
      [
        {
          id: "thinking",
          label: "Thinking",
          type: "select",
          options: [{ id: "low", label: "Low" }],
        },
      ],
    );
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      for (const options of [
        [{ id: "missing", value: "low" }],
        [{ id: "thinking", value: "high" }],
        [
          { id: "thinking", value: "low" },
          { id: "thinking", value: "low" },
        ],
      ]) {
        const outcome = yield* service.spawn(h.scope, { ...h.input, options }).pipe(Effect.result);
        expect(outcome._tag).toBe("Failure");
      }
      expect(h.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("forwards fixed options while steering an active child", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      "codex",
      "claudeAgent",
      "full-access",
      false,
      false,
      undefined,
      false,
      false,
      [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [{ id: "high", label: "High" }],
        },
      ],
    );
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, {
        ...h.input,
        options: [{ id: "effort", value: "high" }],
      });
      yield* Deferred.await(h.sent);
      yield* service.send(h.scope, { runId: run.runId, prompt: "Continue" });
      expect(h.sentSelections[1]).toEqual(h.sentSelections[0]);
      yield* service.cancel(h.scope, run.runId);
      expect((yield* service.result(h.scope, run.runId, 30_000)).status).toBe("cancelled");
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("does not escalate a restricted parent into a full-access native child", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("codex", "pi", "approval-required");
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      expect((yield* service.capabilities(h.scope)).available).toBe(false);
      expect((yield* service.spawn(h.scope, h.input).pipe(Effect.result))._tag).toBe("Failure");
      expect(h.starts).toHaveLength(0);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("passes a restricted Pi parent's runtime mode to a Codex child", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("pi", "codex", "approval-required", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      expect((yield* service.capabilities(h.scope)).available).toBe(true);
      const run = yield* service.spawn(h.scope, h.input);
      const child = yield* Deferred.await(h.sent);
      expect(h.starts[0]?.runtimeMode).toBe("approval-required");
      yield* service.cancel(h.scope, run.runId);
      yield* service.result(h.scope, run.runId, 30_000);
      expect(h.stopped).toEqual([child]);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("cancels only its child and waits for native session cleanup", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("claudeAgent", "codex", "full-access", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      const child = yield* Deferred.await(h.sent);
      yield* service.cancel(h.scope, run.runId);
      expect((yield* service.result(h.scope, run.runId, 30_000)).status).toBe("cancelled");
      expect(h.stopped).toEqual([child]);
      expect((yield* service.cancel(h.scope, run.runId)).status).toBe("cancelled");
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("exposes native delegation through MCP with invocation-bound result collection", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      clientCapabilities: {},
      clientInfo: { name: "test", version: "1" },
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
      getClient: Effect.die("unused"),
    });
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const spawned = yield* server.callTool({ name: "subagent_spawn", arguments: h.input });
      expect(spawned.isError).toBe(false);
      const run = yield* decodeChildRunResult(spawned.structuredContent);
      const collected = yield* server.callTool({
        name: "subagent_result",
        arguments: { runId: run.runId, waitMs: 30_000, acknowledge: true },
      });
      const result = yield* decodeChildRunResult(collected.structuredContent);
      expect(result.status).toBe("completed");
      expect(result.output).toBe("Native child result");
    }).pipe(
      Effect.provideService(McpInvocationContext, h.scope),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(
        DelegationToolkitRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(h.services),
        ),
      ),
    );
  }),
);

it.effect("bounds child output and fails interactive requests without approving them", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("codex", "claudeAgent", "full-access", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      const threadId = yield* Deferred.await(h.sent);
      yield* PubSub.publish(h.events, {
        type: "content.delta",
        eventId: EventId.make("large-output"),
        provider: ProviderDriverKind.make("claudeAgent"),
        threadId,
        createdAt: now,
        payload: { streamKind: "assistant_text", delta: "x".repeat(100_001) },
      });
      yield* PubSub.publish(h.events, {
        type: "request.opened",
        eventId: EventId.make("approval"),
        provider: ProviderDriverKind.make("claudeAgent"),
        threadId,
        createdAt: now,
        payload: { requestType: "command_execution_approval" },
      });
      const result = yield* service.result(h.scope, run.runId, 30_000);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("interactive input");
      expect(result.output).toHaveLength(100_000);
      expect(result.outputTruncated).toBe(true);
      expect(h.stopped).toEqual([threadId]);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("reserves the per-parent concurrency limit before asynchronous startup", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("codex", "claudeAgent", "full-access", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const outcomes = yield* Effect.all(
        Array.from({ length: 5 }, () => service.spawn(h.scope, h.input).pipe(Effect.result)),
        { concurrency: "unbounded" },
      );
      expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(4);
      expect(outcomes.filter((outcome) => outcome._tag === "Failure")).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome._tag === "Success") {
          yield* service.cancel(h.scope, outcome.success.runId);
          expect((yield* service.result(h.scope, outcome.success.runId, 30_000)).status).toBe(
            "cancelled",
          );
        }
      }
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("does not leave a starting row behind when initial Agents projection fails", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("codex", "claudeAgent", "full-access", false, true);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      expect((yield* service.spawn(h.scope, h.input).pipe(Effect.result))._tag).toBe("Failure");
      expect(h.starts).toHaveLength(0);
      const runs = yield* Effect.all(
        Array.from({ length: 4 }, () => service.spawn(h.scope, h.input)),
        { concurrency: "unbounded" },
      );
      expect(runs).toHaveLength(4);
      for (const run of runs) yield* service.cancel(h.scope, run.runId);
      for (const run of runs) yield* service.result(h.scope, run.runId, 30_000);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("steers active children and resumes terminal children as linked follow-ups", () =>
  Effect.gen(function* () {
    const activeHarness = yield* makeHarness("codex", "claudeAgent", "full-access", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(activeHarness.scope, activeHarness.input);
      yield* service.send(activeHarness.scope, { runId: run.runId, prompt: "Narrow the scope" });
      expect(activeHarness.sentPrompts[0]).toContain("Do the task");
      expect(activeHarness.sentPrompts[0]).toContain("Your stable agent ID is");
      expect(activeHarness.sentPrompts[1]).toBe("Narrow the scope");
      yield* service.cancel(activeHarness.scope, run.runId);
      yield* service.result(activeHarness.scope, run.runId, 30_000);
    }).pipe(Effect.provide(activeHarness.services));

    const followupHarness = yield* makeHarness();
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const first = yield* service.spawn(followupHarness.scope, followupHarness.input);
      expect((yield* service.result(followupHarness.scope, first.runId, 30_000)).status).toBe(
        "completed",
      );
      const followup = yield* service.send(followupHarness.scope, {
        runId: first.runId,
        prompt: "Check one more thing",
      });
      expect(followup.runId).not.toBe(first.runId);
      expect(followup.agentId).toBe(first.agentId);
      expect(followup.generation).toBe(2);
      expect(followupHarness.starts[1]?.resumeCursor).toEqual({ session: "native-session" });
      expect((yield* service.result(followupHarness.scope, followup.runId, 30_000)).status).toBe(
        "completed",
      );
    }).pipe(Effect.provide(followupHarness.services));
  }),
);

it.effect("delivers and explicitly acknowledges a durable cross-provider sibling message", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      "codex",
      "claudeAgent",
      "full-access",
      false,
      false,
      undefined,
      false,
      false,
      undefined,
      "codex",
    );
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const sender = yield* service.spawn(h.scope, h.input);
      const recipient = yield* service.spawn(h.scope, h.secondInput);
      const senderRequest = h.credentialRequests.find(
        (request) => request.agentMessaging?.agentId === sender.agentId,
      );
      const recipientRequest = h.credentialRequests.find(
        (request) => request.agentMessaging?.agentId === recipient.agentId,
      );
      expect(senderRequest).toBeDefined();
      expect(recipientRequest).toBeDefined();

      const sent = yield* service.agentSend(messagingScope(h.scope, senderRequest!), {
        messageId: "cross-provider-1",
        targetAgentId: recipient.agentId,
        message: "Share the parser finding",
      });
      expect(sent).toMatchObject({
        messageId: "cross-provider-1",
        senderAgentId: sender.agentId,
        targetAgentId: recipient.agentId,
        status: "notified",
        deliveryRunId: recipient.runId,
      });
      expect(h.sentPrompts.at(-1)).toContain(
        `[T3 agent message cross-provider-1 from Investigate (${sender.agentId})]`,
      );
      expect(h.sentPrompts.at(-1)).toContain("Share the parser finding");
      const promptCount = h.sentPrompts.length;
      expect(
        yield* service.agentSend(messagingScope(h.scope, senderRequest!), {
          messageId: "cross-provider-1",
          targetAgentId: recipient.agentId,
          message: "Share the parser finding",
        }),
      ).toEqual(sent);
      expect(h.sentPrompts).toHaveLength(promptCount);

      const recipientScope = messagingScope(h.scope, recipientRequest!);
      const inbox = yield* service.agentInbox(recipientScope, {});
      expect(inbox.peers).toContainEqual(
        expect.objectContaining({ agentId: sender.agentId, title: "Investigate" }),
      );
      expect(inbox.messages).toEqual([
        expect.objectContaining({
          messageId: "cross-provider-1",
          senderAgentId: sender.agentId,
          senderTitle: "Investigate",
          message: "Share the parser finding",
        }),
      ]);
      const acknowledged = yield* service.agentInbox(recipientScope, {
        acknowledgeMessageIds: ["cross-provider-1"],
      });
      expect(acknowledged.acknowledgedMessageIds).toEqual(["cross-provider-1"]);
      expect(acknowledged.messages).toEqual([]);

      for (let index = 0; index < 4; index += 1) {
        yield* service.agentSend(messagingScope(h.scope, senderRequest!), {
          messageId: `large-message-${index}`,
          targetAgentId: recipient.agentId,
          message: String(index).repeat(20_000),
        });
      }
      const bounded = yield* service.agentInbox(recipientScope, {});
      expect(bounded.messages).toHaveLength(3);
      expect(bounded.messages.every(({ message }) => message.length === 20_000)).toBe(true);
      expect(bounded.hasMore).toBe(true);

      yield* service.cancel(h.scope, sender.runId);
      yield* service.cancel(h.scope, recipient.runId);
      yield* service.result(h.scope, sender.runId, 30_000);
      yield* service.result(h.scope, recipient.runId, 30_000);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("denies cross-team targets and never restarts a cancelled recipient", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      "codex",
      "claudeAgent",
      "full-access",
      false,
      false,
      undefined,
      false,
      false,
      undefined,
      "codex",
    );
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const sender = yield* service.spawn(h.scope, h.input);
      const otherScope = { ...h.scope, threadId: otherParentId, providerSessionId: "other-parent" };
      const otherTeam = yield* service.spawn(otherScope, h.secondInput);
      const senderRequest = h.credentialRequests.find(
        (request) => request.agentMessaging?.agentId === sender.agentId,
      );
      expect(senderRequest).toBeDefined();
      const senderScope = messagingScope(h.scope, senderRequest!);
      const crossTeam = yield* service
        .agentSend(senderScope, {
          messageId: "cross-team",
          targetAgentId: otherTeam.agentId,
          message: "This must be rejected",
        })
        .pipe(Effect.result);
      expect(crossTeam._tag).toBe("Failure");
      if (crossTeam._tag === "Failure") {
        expect(crossTeam.failure.message).toContain("Unknown target agent in this team");
      }

      const cancelled = yield* service.spawn(h.scope, h.secondInput);
      yield* service.cancel(h.scope, cancelled.runId);
      expect((yield* service.result(h.scope, cancelled.runId, 30_000)).status).toBe("cancelled");
      const startCount = h.starts.length;
      const cancelledSend = yield* service
        .agentSend(senderScope, {
          messageId: "cancelled-target",
          targetAgentId: cancelled.agentId,
          message: "Do not resurrect",
        })
        .pipe(Effect.result);
      expect(cancelledSend._tag).toBe("Failure");
      expect(h.starts).toHaveLength(startCount);

      yield* service.cancel(h.scope, sender.runId);
      yield* service.cancel(otherScope, otherTeam.runId);
      yield* service.result(h.scope, sender.runId, 30_000);
      yield* service.result(otherScope, otherTeam.runId, 30_000);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("serializes simultaneous peer sends across a recipient completion boundary", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      "codex",
      "claudeAgent",
      "full-access",
      false,
      false,
      undefined,
      false,
      false,
      [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [{ id: "high", label: "High" }],
        },
      ],
      "codex",
    );
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const firstSender = yield* service.spawn(h.scope, h.secondInput);
      const secondSender = yield* service.spawn(h.scope, {
        ...h.secondInput,
        title: "Second sender",
      });
      const recipientOptions = [{ id: "effort", value: "high" }];
      const recipient = yield* service.spawn(h.scope, {
        ...h.input,
        options: recipientOptions,
      });
      const recipientRequest = h.credentialRequests.find(
        (request) => request.agentMessaging?.agentId === recipient.agentId,
      );
      expect(recipientRequest).toBeDefined();
      yield* PubSub.publish(h.events, {
        type: "turn.completed",
        eventId: EventId.make("recipient-completed-at-send"),
        provider: ProviderDriverKind.make("claudeAgent"),
        threadId: recipientRequest!.threadId,
        turnId: h.sentTurns[2],
        createdAt: now,
        payload: { state: "completed" },
      });
      h.setParentRuntimeMode("approval-required");

      const firstScope = messagingScope(
        h.scope,
        h.credentialRequests.find(
          (request) => request.agentMessaging?.agentId === firstSender.agentId,
        )!,
      );
      const secondScope = messagingScope(
        h.scope,
        h.credentialRequests.find(
          (request) => request.agentMessaging?.agentId === secondSender.agentId,
        )!,
      );
      const [first, second] = yield* Effect.all(
        [
          service.agentSend(firstScope, {
            messageId: "completion-race-1",
            targetAgentId: recipient.agentId,
            message: "First",
          }),
          service.agentSend(secondScope, {
            messageId: "completion-race-2",
            targetAgentId: recipient.agentId,
            message: "Second",
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(first.deliveryRunId).toBe(second.deliveryRunId);
      const recipientCredentials = h.credentialRequests.filter(
        (request) => request.agentMessaging?.agentId === recipient.agentId,
      );
      expect(recipientCredentials).toHaveLength(2);
      expect(h.starts.at(-1)?.runtimeMode).toBe("approval-required");
      expect(h.starts.at(-1)?.modelSelection).toEqual({
        instanceId: h.input.providerInstanceId,
        model: h.input.model,
        options: recipientOptions,
      });
      expect((yield* service.result(h.scope, first.deliveryRunId)).requestedOptions).toEqual(
        recipientOptions,
      );
      const resumedScope = messagingScope(h.scope, recipientCredentials[1]!);
      expect(
        (yield* service.agentInbox(resumedScope, {})).messages.map(({ messageId }) => messageId),
      ).toEqual(["completion-race-1", "completion-race-2"]);

      yield* service.cancel(h.scope, firstSender.runId);
      yield* service.cancel(h.scope, secondSender.runId);
      yield* service.cancel(h.scope, first.deliveryRunId);
      yield* service.result(h.scope, firstSender.runId, 30_000);
      yield* service.result(h.scope, secondSender.runId, 30_000);
      yield* service.result(h.scope, first.deliveryRunId, 30_000);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("waits for a Codex queued steer turn instead of stopping after the prior turn", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("claudeAgent", "codex", "full-access", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      const threadId = yield* Deferred.await(h.sent);
      yield* service.send(h.scope, { runId: run.runId, prompt: "Run after this turn" });
      const [firstTurn, queuedTurn] = h.sentTurns;
      expect(firstTurn).toBeDefined();
      expect(queuedTurn).toBeDefined();
      yield* PubSub.publish(h.events, {
        type: "turn.completed",
        eventId: EventId.make("first-complete"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: firstTurn,
        createdAt: now,
        payload: { state: "completed" },
      });
      yield* Effect.yieldNow;
      expect((yield* service.result(h.scope, run.runId)).status).toBe("running");
      expect(h.stopped).toHaveLength(0);
      yield* PubSub.publish(h.events, {
        type: "turn.completed",
        eventId: EventId.make("queued-complete"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: queuedTurn,
        createdAt: now,
        payload: { state: "completed" },
      });
      expect((yield* service.result(h.scope, run.runId, 30_000)).status).toBe("completed");
      expect(h.stopped).toEqual([threadId]);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("serializes concurrent steers before accepting their terminal events", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness(
      "claudeAgent",
      "codex",
      "full-access",
      false,
      false,
      undefined,
      false,
      true,
    );
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      const childThreadId = yield* Deferred.await(h.sent);
      const firstSteer = yield* service
        .send(h.scope, { runId: run.runId, prompt: "First steer" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(h.firstSteerStarted);
      const [status] = yield* service.controlPlane.status();
      const secondSteer = yield* service.controlPlane
        .steer({
          managerId: status!.managerId!,
          runId: run.runId,
          text: "Second steer",
        })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(h.releaseFirstSteer, undefined);
      yield* Fiber.join(firstSteer);
      yield* Deferred.await(h.secondSteerStarted);
      yield* PubSub.publish(h.events, {
        type: "turn.completed",
        eventId: EventId.make("first-steer-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        turnId: h.sentTurns[1],
        createdAt: now,
        payload: { state: "completed" },
      });
      yield* Deferred.succeed(h.releaseSecondSteer, undefined);
      yield* Fiber.join(secondSteer);
      yield* Effect.yieldNow;
      expect(h.stopped).toHaveLength(0);
      yield* PubSub.publish(h.events, {
        type: "turn.completed",
        eventId: EventId.make("second-steer-completed"),
        provider: ProviderDriverKind.make("codex"),
        threadId: childThreadId,
        turnId: h.sentTurns[2],
        createdAt: now,
        payload: { state: "completed" },
      });
      expect((yield* service.result(h.scope, run.runId, 30_000)).status).toBe("completed");
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("exposes active native children through the shared Agents control plane", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("codex", "claudeAgent", "full-access", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      const childThreadId = yield* Deferred.await(h.sent);
      const [status] = yield* service.controlPlane.status();
      expect(status).toMatchObject({
        supported: true,
        threadId: parentId,
        controls: { steer: { enabled: true }, cancel: { enabled: true } },
      });
      expect(status?.managerId).toMatch(/^t3-native:/);
      yield* service.controlPlane.steer({
        managerId: status!.managerId!,
        runId: run.runId,
        text: "Steer from Agents",
      });
      expect(h.sentPrompts[0]).toContain("Do the task");
      expect(h.sentPrompts[1]).toBe("Steer from Agents");
      yield* service.controlPlane.cancel({ managerId: status!.managerId!, runId: run.runId });
      expect((yield* service.result(h.scope, run.runId, 30_000)).status).toBe("cancelled");
      expect(h.stopped).toEqual([childThreadId]);
      expect(yield* service.controlPlane.status()).toEqual([]);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("keeps the sidebar liveness live while native siblings settle independently", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("codex", "claudeAgent", "full-access", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const first = yield* service.spawn(h.scope, h.input);
      const second = yield* service.spawn(h.scope, h.secondInput);
      expect(h.backgroundLiveness.getThreadBackgroundLiveness(parentId)).toBe("working");

      yield* service.cancel(h.scope, first.runId);
      expect((yield* service.result(h.scope, first.runId, 30_000)).status).toBe("cancelled");
      expect(h.backgroundLiveness.getThreadBackgroundLiveness(parentId)).toBe("working");

      yield* service.cancel(h.scope, second.runId);
      expect((yield* service.result(h.scope, second.runId, 30_000)).status).toBe("cancelled");
      expect(h.backgroundLiveness.getThreadBackgroundLiveness(parentId)).toBeNull();
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("cancels children on parent exit without automatically restarting the parent", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("codex", "claudeAgent", "full-access", false);
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      yield* Deferred.await(h.sent);
      yield* PubSub.publish(h.events, {
        type: "session.exited",
        eventId: EventId.make("parent-exited"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: h.scope.providerInstanceId,
        threadId: parentId,
        createdAt: now,
        payload: { reason: "stopped" },
      });
      expect((yield* service.result(h.scope, run.runId, 30_000)).status).toBe("cancelled");
      expect(h.commands.some((command) => command.type === "thread.turn.start")).toBe(false);
    }).pipe(Effect.provide(h.services));
  }),
);

it.effect("does not launch a child when its parent exits during durable reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const baseRepository = Context.get(repositoryContext, NativeChildRunRepository);
      const insertReached = yield* Deferred.make<void>();
      const releaseInsert = yield* Deferred.make<void>();
      const parentSuppressed = yield* Deferred.make<void>();
      const repository = NativeChildRunRepository.of({
        ...baseRepository,
        insert: (run) =>
          baseRepository
            .insert(run)
            .pipe(
              Effect.andThen(Deferred.succeed(insertReached, undefined)),
              Effect.andThen(Deferred.await(releaseInsert)),
            ),
        markParentDelivered: (threadId) =>
          baseRepository
            .markParentDelivered(threadId)
            .pipe(Effect.andThen(Deferred.succeed(parentSuppressed, undefined))),
      });
      const h = yield* makeHarness(
        "codex",
        "claudeAgent",
        "full-access",
        false,
        false,
        Layer.succeed(NativeChildRunRepository, repository),
      );
      yield* Effect.gen(function* () {
        const service = yield* ChildRunService;
        const spawn = yield* service
          .spawn(h.scope, h.input)
          .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(insertReached);
        yield* PubSub.publish(h.events, {
          type: "session.exited",
          eventId: EventId.make("parent-exited-during-child-reservation"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: h.scope.providerInstanceId,
          threadId: parentId,
          createdAt: now,
          payload: { reason: "stopped" },
        });
        yield* Deferred.await(parentSuppressed);
        yield* Deferred.succeed(releaseInsert, undefined);
        expect((yield* Fiber.join(spawn))._tag).toBe("Failure");
        expect(h.starts).toHaveLength(0);
        expect(yield* baseRepository.listActive()).toEqual([]);
      }).pipe(Effect.provide(h.services));
    }),
  ),
);

it.effect(
  "suppresses completion delivery when an explicit parent stop races terminal activity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repositoryScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
        const repositoryContext = yield* Layer.buildWithScope(
          NativeChildRunRepositoryAuto,
          repositoryScope,
        );
        const baseRepository = Context.get(repositoryContext, NativeChildRunRepository);
        const parentSuppressed = yield* Deferred.make<void>();
        const repository = NativeChildRunRepository.of({
          ...baseRepository,
          markParentDelivered: (threadId) =>
            baseRepository
              .markParentDelivered(threadId)
              .pipe(Effect.andThen(Deferred.succeed(parentSuppressed, undefined))),
        });
        const h = yield* makeHarness(
          "codex",
          "claudeAgent",
          "full-access",
          false,
          false,
          Layer.succeed(NativeChildRunRepository, repository),
          true,
        );
        yield* Effect.gen(function* () {
          const service = yield* ChildRunService;
          const run = yield* service.spawn(h.scope, h.input);
          const childThreadId = yield* Deferred.await(h.sent);
          yield* PubSub.publish(h.events, {
            type: "turn.completed",
            eventId: EventId.make("child-completed-before-parent-stop"),
            provider: ProviderDriverKind.make("claudeAgent"),
            threadId: childThreadId,
            turnId: h.sentTurns[0],
            createdAt: now,
            payload: { state: "completed" },
          });
          yield* Deferred.await(h.terminalActivityReached);
          yield* PubSub.publish(h.domainEvents, {
            sequence: 1,
            eventId: EventId.make("parent-stop-during-child-completion"),
            aggregateKind: "thread",
            aggregateId: parentId,
            occurredAt: now,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.session-stop-requested",
            payload: { threadId: parentId, createdAt: now },
          });
          yield* Deferred.await(parentSuppressed);
          yield* Deferred.succeed(h.releaseTerminalActivity, undefined);
          expect((yield* service.result(h.scope, run.runId, 30_000)).status).toBe("completed");
          expect(h.commands.some((command) => command.type === "thread.turn.start")).toBe(false);
        }).pipe(Effect.provide(h.services));
      }),
    ),
);

it.effect("stops started child sessions and releases result waiters when the service closes", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("codex", "claudeAgent", "full-access", false);
    const childScope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(h.services, childScope);
    const service = Context.get(context, ChildRunService);
    const run = yield* service.spawn(h.scope, h.input);
    const childThreadId = yield* Deferred.await(h.sent);
    const waiter = yield* service
      .result(h.scope, run.runId, 30_000)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Scope.close(childScope, Exit.void);
    expect(h.stopped).toEqual([childThreadId]);
    expect((yield* Fiber.join(waiter)).status).toBe("running");
  }),
);

it.effect("preserves options for a repository-backed restart follow-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const repositoryScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(repositoryScope, Exit.void));
      const repositoryContext = yield* Layer.buildWithScope(
        NativeChildRunRepositoryAuto,
        repositoryScope,
      );
      const repository = Context.get(repositoryContext, NativeChildRunRepository);
      const runId = RuntimeTaskId.make("native-crash-window");
      const childThreadId = ThreadId.make("child-crash-window");
      const createdAt = "2026-09-06T00:00:00.000Z";
      const runNumber = yield* repository.reserveRunNumber({
        runId,
        childThreadId,
        allocatedAt: createdAt,
      });
      yield* repository.insert(
        NativeChildRun.make({
          runId,
          agentId: runId,
          runNumber,
          parentRunId: null,
          parentThreadId: parentId,
          childThreadId,
          providerInstanceId: ProviderInstanceId.make("child-provider"),
          provider: ProviderDriverKind.make("claudeAgent"),
          model: "native-model",
          title: "Recovered child",
          requestedOptions: [{ id: "effort", value: "high" }],
          runtimeMode: "full-access",
          cwd: "/workspace",
          resumeCursor: { session: "recovered" },
          generation: 1,
          status: "completed",
          output: "Recovered result",
          outputTruncated: false,
          error: null,
          deliveryState: "pending",
          deliveryAttempt: 0,
          createdAt,
          updatedAt: createdAt,
        }),
      );
      const h = yield* makeHarness(
        "codex",
        "claudeAgent",
        "full-access",
        false,
        false,
        Layer.succeed(NativeChildRunRepository, repository),
        false,
        false,
        [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      );
      yield* Effect.gen(function* () {
        const service = yield* ChildRunService;
        const activities = h.commands.filter(
          (command) => command.type === "thread.activity.append",
        );
        expect(activities.map((command) => command.activity.kind)).toEqual([
          "task.started",
          "task.completed",
        ]);
        expect(
          activities.map(
            (command) =>
              decodeNativeActivityPayloadSync(command.activity.payload).subagentRun
                .historyAvailability,
          ),
        ).toEqual(["summary-only", "summary-only"]);
        expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          1,
        );
        const followup = yield* service.send(h.scope, {
          runId,
          prompt: "Continue from the recovered session",
        });
        yield* Deferred.await(h.sent);
        expect(followup.requestedOptions).toEqual([{ id: "effort", value: "high" }]);
        expect(h.starts[0]?.modelSelection).toEqual({
          instanceId: ProviderInstanceId.make("child-provider"),
          model: "native-model",
          options: [{ id: "effort", value: "high" }],
        });
        yield* service.cancel(h.scope, followup.runId);
        yield* service.result(h.scope, followup.runId, 30_000);
      }).pipe(Effect.provide(h.services));
    }),
  ),
);
