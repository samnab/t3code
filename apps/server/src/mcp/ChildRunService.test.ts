import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  RuntimeTaskId,
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
import { McpSchema, McpServer } from "effect/unstable/ai";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { NativeChildRunRepositoryAuto } from "../persistence/Layers/NativeChildRuns.ts";
import {
  NativeChildRun,
  NativeChildRunRepository,
} from "../persistence/Services/NativeChildRuns.ts";
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
) {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
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
  const adapter: ProviderAdapterShape<never> = {
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
  const secondAdapter: ProviderAdapterShape<never> = {
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
    Layer.mock(ProviderService)({ streamEvents: Stream.fromPubSub(events) }),
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Effect.suspend(() => {
          if (shouldFailActivity && command.type === "thread.activity.append") {
            shouldFailActivity = false;
            return Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "simulated activity rejection",
              }),
            );
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
        }),
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
    commands,
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
        arguments: { runId: run.runId, waitMs: 30_000 },
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
