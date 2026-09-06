import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { ChildRunResult, ChildRunService, layer } from "./ChildRunService.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { DelegationToolkitRegistrationLive } from "./McpHttpServer.ts";
import { readMcpProviderSession } from "./McpProviderSession.ts";

const now = "2026-09-06T00:00:00.000Z";
const parentId = ThreadId.make("parent");
const turnId = TurnId.make("child-turn");
const decodeChildRunResult = Schema.decodeUnknownEffect(ChildRunResult);
const makeHarness = Effect.fn("makeHarness")(function* (
  parentDriver = "codex",
  childDriver = "claudeAgent",
  mode: RuntimeMode = "full-access",
  complete = true,
  failFirstActivity = false,
) {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sent = yield* Deferred.make<ThreadId>();
  const starts: Array<ProviderSessionStartInput> = [];
  const stopped: Array<ThreadId> = [];
  const sentPrompts: string[] = [];
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
        sentPrompts.push(input.input ?? "");
        yield* Deferred.succeed(sent, input.threadId);
        if (complete) {
          yield* PubSub.publish(events, {
            type: "content.delta",
            eventId: EventId.make("text"),
            provider: ProviderDriverKind.make(childDriver),
            threadId: input.threadId,
            createdAt: now,
            payload: { streamKind: "assistant_text", delta: "Native child result" },
          });
          yield* PubSub.publish(events, {
            type: "turn.completed",
            eventId: EventId.make("complete"),
            provider: ProviderDriverKind.make(childDriver),
            threadId: input.threadId,
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
          return Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          });
        }),
      subscribeDomainEvents: Effect.succeed(Stream.empty),
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
    commands,
    sent,
    events,
    input: {
      providerInstanceId: childInstance,
      model: "native-model",
      title: "Investigate",
      prompt: "Do the task",
    },
    services: layer.pipe(
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
