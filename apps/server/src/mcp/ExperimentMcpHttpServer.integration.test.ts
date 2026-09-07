import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  ExperimentCoordinator,
  ExperimentService,
  layer as ExperimentServiceLive,
  type ExperimentCoordinatorShape,
} from "../experiments/ExperimentService.ts";
import type { ExperimentIdentity, ExperimentThreadContext } from "../experiments/Model.ts";
import * as ThreadExperiments from "../persistence/ThreadExperiments.ts";
import * as ChildRunService from "./ChildRunService.ts";
import * as ExperimentMcpHttpServer from "./ExperimentMcpHttpServer.ts";
import * as ExperimentMcpServiceLive from "./ExperimentMcpServiceLive.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-experiment-mcp-"));
  roots.push(root);
  NodeChildProcess.execFileSync("git", ["init", "-b", "experiment/test"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: root,
  });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  NodeFS.writeFileSync(NodePath.join(root, "score.txt"), "1\n");
  NodeChildProcess.execFileSync("git", ["add", "score.txt"], { cwd: root });
  NodeChildProcess.execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });
  NodeFS.mkdirSync(NodePath.join(root, ".auto"));
  NodeFS.writeFileSync(
    NodePath.join(root, ".auto/config.json"),
    JSON.stringify({
      version: 1,
      branch: "experiment/test",
      files: ["score.txt"],
      evaluator: {
        argv: [
          "node",
          "-e",
          "const fs=require('fs');const score=Number(fs.readFileSync('score.txt','utf8'));process.stdout.write(JSON.stringify({metrics:{score}}))",
        ],
        metric: "score",
        direction: "higher",
        minimumImprovement: 0.5,
      },
      checks: [["node", "-e", "process.exit(0)"]],
      limits: {
        maxExperiments: 10,
        maxApplyBytes: 10_000,
        maxOutputBytes: 10_000,
        evaluatorTimeoutSeconds: 10,
        checkTimeoutSeconds: 10,
        maxTotalSeconds: 600,
      },
    }),
  );
  return root;
}

function parseMcpResponse(raw: string): {
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
  readonly result?: {
    readonly isError?: boolean;
    readonly structuredContent?: unknown;
    readonly content?: ReadonlyArray<{ readonly text?: string }>;
    readonly tools?: ReadonlyArray<{ readonly name: string }>;
  };
} {
  const data = raw
    .split(/\r?\n/)
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  return JSON.parse(data ?? raw);
}

it.effect("authenticates experiment MCP calls against the real experiment service", () => {
  const cwd = makeRepo();
  const threadId = ThreadId.make("thread-experiment-mcp");
  const providerInstanceId = ProviderInstanceId.make("claude");
  let thread: ExperimentThreadContext = {
    threadId,
    cwd,
    providerInstanceId,
    providerSessionId: "ordinary-session",
    providerDriver: "claudeAgent",
    providerSupported: true,
    idle: true,
    pendingChildRun: false,
  };
  let authorizationHeader = "";

  const environment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-experiment-mcp")),
    getDescriptor: Effect.die("unused"),
  });
  const CoordinatorLive = Layer.effect(
    ExperimentCoordinator,
    Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const coordinator: ExperimentCoordinatorShape = {
        resolveThread: () => Effect.sync(() => thread),
        startProvider: (input) =>
          Effect.gen(function* () {
            const issued = yield* registry.issueExperiment({
              threadId: ThreadId.make(input.threadId),
              providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
              runId: input.runId,
              generation: input.generation,
            });
            authorizationHeader = issued.config.authorizationHeader;
            const identity: ExperimentIdentity = {
              threadId: input.threadId,
              providerInstanceId: input.providerInstanceId,
              providerSessionId: issued.config.providerSessionId,
              runId: input.runId,
              generation: input.generation,
            };
            thread = {
              ...thread,
              providerSessionId: identity.providerSessionId,
              providerGeneration: identity.generation,
            };
            return identity;
          }),
        stopProvider: () => Effect.void,
        activateGoal: () => Effect.void,
        syncSummary: () => Effect.void,
        holdGoal: () => Effect.void,
      };
      return ExperimentCoordinator.of(coordinator);
    }),
  );
  const ThreadExperimentsLive = ThreadExperiments.memoryLayer;
  const DomainLive = ExperimentServiceLive.pipe(
    Layer.provide(ThreadExperimentsLive),
    Layer.provide(CoordinatorLive),
  );
  const RegistryAndDomainLive = Layer.merge(DomainLive, ThreadExperimentsLive).pipe(
    Layer.provideMerge(McpSessionRegistry.layer),
  );
  const RoutesLive = Layer.mergeAll(
    McpHttpServer.layer.pipe(
      Layer.provide(PreviewAutomationBroker.layer),
      Layer.provide(
        Layer.mock(ChildRunService.ChildRunService)({
          controlPlane: {
            status: () => Effect.succeed([]),
            steer: () => Effect.die("unused"),
            cancel: () => Effect.die("unused"),
          },
        }),
      ),
    ),
    ExperimentMcpHttpServer.layer.pipe(Layer.provide(ExperimentMcpServiceLive.layer)),
  );
  const AppLive = HttpRouter.serve(RoutesLive, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provideMerge(RegistryAndDomainLive),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
  );

  return Effect.scoped(
    Effect.gen(function* () {
      const experiments = yield* ExperimentService;
      const preview = yield* experiments.preview({ threadId, objective: "Improve score" });
      const started = yield* experiments.start({
        threadId,
        objective: "Improve score",
        confirmationId: preview.confirmationId,
      });
      expect(authorizationHeader).not.toBe("");

      const httpClient = yield* HttpClient.HttpClient;
      const initializeResponse = yield* httpClient.post("/mcp/experiment", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: authorizationHeader,
        },
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "experiment-integration-test", version: "1.0.0" },
            },
          }),
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeUndefined();

      const toolsResponse = yield* httpClient.post("/mcp/experiment", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: authorizationHeader,
          "mcp-session-id": sessionId!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
          "application/json",
        ),
      });
      const tools = parseMcpResponse(yield* toolsResponse.text).result?.tools;
      expect(tools?.map((tool) => tool.name).toSorted()).toEqual([
        "experiment_apply",
        "experiment_evaluate",
        "experiment_list_files",
        "experiment_read_file",
        "experiment_status",
      ]);

      const callTool = Effect.fn("test.callExperimentTool")(function* (
        id: number,
        name: string,
        args: Readonly<Record<string, unknown>>,
      ) {
        const response = yield* httpClient.post("/mcp/experiment", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: authorizationHeader,
            "mcp-session-id": sessionId!,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name, arguments: args },
            }),
            "application/json",
          ),
        });
        expect(response.status).toBe(200);
        return parseMcpResponse(yield* response.text);
      });

      const status = yield* callTool(3, "experiment_status", {});
      expect(status.result?.isError).not.toBe(true);
      expect(status.result?.structuredContent).toMatchObject({
        runId: started.runId,
        phase: "ready",
        baselineMetric: 1,
      });

      const store = yield* ThreadExperiments.ThreadExperimentStore;
      const approvedFile = NodePath.join(cwd, "score.txt");
      const baselineBytes = NodeFS.readFileSync(approvedFile);
      const baselineMode = NodeFS.statSync(approvedFile).mode;
      const baselineHead = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
      }).trim();

      const noOp = yield* callTool(4, "experiment_apply", {
        hypothesis: "Leave the score unchanged",
        changes: [{ path: "score.txt", content: "1\n" }],
      });
      expect(noOp.result?.isError).toBe(true);
      expect(noOp.result?.content?.[0]?.text).toContain(
        "Candidate must change exactly the requested approved paths.",
      );
      const afterNoOp = Option.getOrThrow(yield* store.get(threadId));
      expect(afterNoOp).toMatchObject({
        phase: "ready",
        armed: true,
        pending: null,
        experimentsRun: 1,
        experimentsRestored: 1,
      });
      expect(NodeFS.readFileSync(approvedFile)).toEqual(baselineBytes);
      expect(NodeFS.statSync(approvedFile).mode).toBe(baselineMode);
      expect(
        NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim(),
      ).toBe(baselineHead);

      const malformed = yield* callTool(5, "experiment_apply", {
        hypothesis: "Malformed candidate",
        changes: [{ path: "score.txt" }],
      });
      expect(malformed.error?.code).toBe(-32602);
      expect(malformed.error?.message).toContain("Invalid parameters for tool 'experiment_apply'");
      const afterMalformed = Option.getOrThrow(yield* store.get(threadId));
      expect(afterMalformed).toMatchObject({
        phase: "ready",
        armed: true,
        pending: null,
        experimentsRun: 1,
        experimentsRestored: 1,
      });
      expect(NodeFS.readFileSync(approvedFile)).toEqual(baselineBytes);
      expect(NodeFS.statSync(approvedFile).mode).toBe(baselineMode);
      expect(
        NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
          cwd,
          encoding: "utf8",
        }).trim(),
      ).toBe(baselineHead);

      const applied = yield* callTool(6, "experiment_apply", {
        hypothesis: "Increase the score",
        changes: [{ path: "score.txt", content: "2\n" }],
      });
      expect(applied.result?.isError).not.toBe(true);

      const evaluated = yield* callTool(7, "experiment_evaluate", {});
      expect(evaluated.result?.isError).not.toBe(true);
      expect(evaluated.result?.structuredContent).toMatchObject({ outcome: "kept", metric: 2 });
      expect(NodeFS.readFileSync(NodePath.join(cwd, "score.txt"), "utf8")).toBe("2\n");

      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const generalCredential = yield* registry.issue({
        threadId: ThreadId.make("thread-general-mcp"),
        providerInstanceId,
        capabilities: ["preview", "delegation"],
      });
      const generalInitialize = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: generalCredential.config.authorizationHeader,
        },
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 8,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "general-integration-test", version: "1.0.0" },
            },
          }),
          "application/json",
        ),
      });
      const generalSessionId = generalInitialize.headers["mcp-session-id"];
      const generalToolsResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: generalCredential.config.authorizationHeader,
          "mcp-session-id": generalSessionId!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(
          JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
          "application/json",
        ),
      });
      const generalTools = parseMcpResponse(yield* generalToolsResponse.text).result?.tools;
      expect(generalTools?.some((tool) => tool.name.startsWith("experiment_"))).toBe(false);

      const mismatched = yield* registry.issueExperiment({
        threadId,
        providerInstanceId,
        providerSessionId: "mismatched-provider-session",
        runId: started.runId,
        generation: 1,
      });
      authorizationHeader = mismatched.config.authorizationHeader;
      const mismatchInitialize = yield* httpClient.post("/mcp/experiment", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: authorizationHeader,
        },
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 10,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "experiment-integration-test", version: "1.0.0" },
            },
          }),
          "application/json",
        ),
      });
      const mismatchSessionId = mismatchInitialize.headers["mcp-session-id"];
      const mismatchResponse = yield* httpClient.post("/mcp/experiment", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: authorizationHeader,
          "mcp-session-id": mismatchSessionId!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 11,
            method: "tools/call",
            params: { name: "experiment_status", arguments: {} },
          }),
          "application/json",
        ),
      });
      const mismatch = parseMcpResponse(yield* mismatchResponse.text);
      expect(mismatch.result?.isError).toBe(true);
      expect(mismatch.result?.content?.[0]?.text).toContain(
        "Experiment caller identity does not match the owner.",
      );
    }),
  ).pipe(Effect.provide(AppLive));
});
