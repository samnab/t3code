import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Deferred, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { McpSchema, McpServer } from "effect/unstable/ai";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
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
) {
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sent = yield* Deferred.make<ThreadId>();
  const starts: Array<ProviderSessionStartInput> = [];
  const stopped: Array<ThreadId> = [];
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
        };
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
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
        return { threadId: input.threadId, turnId };
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
    streamEvents: Stream.fromPubSub(events),
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
  return {
    scope,
    starts,
    stopped,
    sent,
    events,
    input: {
      providerInstanceId: childInstance,
      model: "native-model",
      title: "Investigate",
      prompt: "Do the task",
    },
    services: layer.pipe(Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry))),
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
        }).pipe(Effect.provide(h.services));
      }),
  );
}

it.effect("denies other parents, renewed sessions and callers without delegation capability", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* Effect.gen(function* () {
      const service = yield* ChildRunService;
      const run = yield* service.spawn(h.scope, h.input);
      for (const scope of [
        { ...h.scope, threadId: ThreadId.make("other-parent") },
        { ...h.scope, providerSessionId: "replacement-session" },
        { ...h.scope, capabilities: new Set<"preview">(["preview"]) },
      ]) {
        const outcome = yield* service.result(scope, run.runId).pipe(Effect.result);
        expect(outcome._tag).toBe("Failure");
      }
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
