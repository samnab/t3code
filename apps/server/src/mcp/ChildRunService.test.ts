import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
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
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ChildRunResult, ChildRunService, layer, layerWithRepository } from "./ChildRunService.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { DelegationToolkitRegistrationLive } from "./McpHttpServer.ts";
import { readMcpProviderSession } from "./McpProviderSession.ts";

const now = "2026-09-06T00:00:00.000Z";
const parentId = ThreadId.make("parent");
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
  const sentTurns: TurnId[] = [];
  const commands: OrchestrationCommand[] = [];
  let shouldFailActivity = failFirstActivity;
  const parentInstance = ProviderInstanceId.make("parent-provider");
  const childInstance = ProviderInstanceId.make("child-provider");
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
  const adapter: ProviderAdapterShape<never> = {
    provider: ProviderDriverKind.make(childDriver),
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (input) =>
      Effect.sync(() => {
        starts.push(input);
        expect(readMcpProviderSession(input.threadId)).toBeUndefined();
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
    listSessions: () => Effect.succeed([parentSession]),
    hasSession: () => Effect.succeed(true),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    streamEvents: Stream.die("ChildRunService must consume ProviderService's canonical stream"),
  };
  const changes = yield* PubSub.unbounded<void>();
  const registry = ProviderAdapterRegistry.of({
    getByInstance: () => Effect.succeed(adapter),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(
          instanceId === childInstance ? childDriver : parentDriver,
        ),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(childDriver),
          continuationKey: "test",
        },
      }),
    listInstances: () => Effect.succeed([childInstance]),
    subscribeChanges: PubSub.subscribe(changes),
  });
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
  );
  return {
    scope,
    starts,
    stopped,
    sentPrompts,
    sentTurns,
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
    services: (repositoryLayer === undefined
      ? layer
      : layerWithRepository.pipe(Layer.provide(repositoryLayer))
    ).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(runtimeServices),
    ),
  };
});

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
          expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
            1,
          );
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
      expect(activeHarness.sentPrompts).toEqual(["Do the task", "Narrow the scope"]);
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
      expect(followup.generation).toBe(2);
      expect(followupHarness.starts[1]?.resumeCursor).toEqual({ session: "native-session" });
      expect((yield* service.result(followupHarness.scope, followup.runId, 30_000)).status).toBe(
        "completed",
      );
    }).pipe(Effect.provide(followupHarness.services));
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
      expect(h.sentPrompts).toEqual(["Do the task", "Steer from Agents"]);
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

it.effect("repairs missing start and terminal projection activities before restart delivery", () =>
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
          runNumber,
          parentRunId: null,
          parentThreadId: parentId,
          childThreadId,
          providerInstanceId: ProviderInstanceId.make("child-provider"),
          provider: ProviderDriverKind.make("claudeAgent"),
          model: "native-model",
          title: "Recovered child",
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
      );
      yield* Effect.gen(function* () {
        yield* ChildRunService;
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
      }).pipe(Effect.provide(h.services));
    }),
  ),
);
