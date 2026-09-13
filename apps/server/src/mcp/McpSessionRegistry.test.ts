import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RuntimeTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual(["preview", "pull-requests"]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual(["pull-requests"]);
    expect(yield* capabilitiesOf(withDevice)).toEqual(["device", "pull-requests"]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("binds only explicitly granted MCP capabilities to the credential", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("delegation-only"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: ["delegation"],
    });
    const scope = yield* registry.resolve(
      issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    expect(scope?.capabilities.has("delegation")).toBe(true);
    expect(scope?.capabilities.has("preview")).toBe(false);
  }),
);

it.effect("issues a child-only messaging credential with a stable team binding", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("child-thread");
    const agentId = RuntimeTaskId.make("native-agent-1");
    const parentThreadId = ThreadId.make("parent-thread");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: ["messaging"],
      agentMessaging: { agentId, parentThreadId },
    });

    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp/agent");
    const scope = yield* registry.resolve(
      issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    expect(scope).toMatchObject({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      agentMessaging: { agentId, parentThreadId },
    });
    expect(scope === undefined ? [] : [...scope.capabilities]).toEqual(["messaging"]);
  }),
);

it.effect("replaces a thread credential with an experiment-only run binding", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("experiment-thread");
    const oldCredential = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      capabilities: ["preview", "delegation"],
    });
    const experimentCredential = yield* registry.issueExperiment({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent-restricted"),
      providerSessionId: "provider-session-restricted",
      runId: "experiment-run-7",
      generation: 4,
    });

    expect(experimentCredential.config.endpoint).toBe("http://127.0.0.1:43123/mcp/experiment");
    expect(
      yield* registry.resolve(oldCredential.config.authorizationHeader.replace(/^Bearer\s+/, "")),
    ).toBeUndefined();

    const scope = yield* registry.resolve(
      experimentCredential.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    expect(scope).toMatchObject({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claudeAgent-restricted"),
      providerSessionId: "provider-session-restricted",
      experiment: { runId: "experiment-run-7", generation: 4 },
    });
    expect(scope).toBeDefined();
    expect(scope === undefined ? [] : [...scope.capabilities]).toEqual(["experiment"]);
  }),
);

it.effect("mints the experiment provider session pin when the caller omits it", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("experiment-thread-fresh-pin");
    const issued = yield* registry.issueExperiment({
      threadId,
      providerInstanceId: ProviderInstanceId.make("pi"),
      runId: "experiment-run-fresh-pin",
      generation: 2,
    });

    expect(issued.config.providerSessionId.length).toBeGreaterThan(0);
    const scope = yield* registry.resolve(
      issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    expect(scope?.providerSessionId).toBe(issued.config.providerSessionId);
  }),
);

it.effect("revokes an experiment credential by its provider session", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const issued = yield* registry.issueExperiment({
      threadId: ThreadId.make("experiment-thread-revoked"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      providerSessionId: "experiment-provider-session",
      runId: "experiment-run-revoked",
      generation: 1,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    yield* registry.revokeProviderSession("different-session");
    expect(yield* registry.resolve(token)).toBeDefined();
    yield* registry.revokeProviderSession("experiment-provider-session");
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("revokes the prior generation when an experiment is rearmed with identical ids", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const binding = {
      threadId: ThreadId.make("experiment-thread-rearm"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: "experiment-provider-session-reused",
      runId: "experiment-run-reused",
    };
    const stale = yield* registry.issueExperiment({ ...binding, generation: 1 });
    const current = yield* registry.issueExperiment({ ...binding, generation: 2 });

    expect(
      yield* registry.resolve(stale.config.authorizationHeader.replace(/^Bearer\s+/, "")),
    ).toBeUndefined();
    expect(
      yield* registry.resolve(current.config.authorizationHeader.replace(/^Bearer\s+/, "")),
    ).toMatchObject({
      threadId: binding.threadId,
      providerInstanceId: binding.providerInstanceId,
      providerSessionId: binding.providerSessionId,
      experiment: { runId: binding.runId, generation: 2 },
    });
  }),
);
