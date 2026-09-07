import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ExperimentToolkitRegistrationLive } from "../ExperimentMcpHttpServer.ts";
import * as ExperimentModel from "../ExperimentMcpModel.ts";
import { ExperimentMcpService } from "../ExperimentMcpService.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";

const identity = {
  threadId: ThreadId.make("thread-experiment"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerSessionId: "provider-session-experiment",
  runId: "run-experiment",
  generation: 3,
};
const invocation = {
  environmentId: EnvironmentId.make("environment-experiment"),
  ...identity,
  capabilities: new Set(["experiment"] as const),
  experiment: { runId: identity.runId, generation: identity.generation },
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "experiment-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const summary: ExperimentModel.ExperimentSummary = {
  runId: identity.runId,
  configDigest: "sha256:test",
  phase: "running",
  metric: 2,
  experimentsRun: 1,
  experimentsKept: 1,
  experimentsRestored: 0,
  baselineMetric: 1,
  bestMetric: 2,
  lastMetric: 2,
  elapsedCommandSeconds: 4,
  maxExperiments: 10,
  maxTotalSeconds: 300,
  lastError: null,
};
const decodeReadFileInput = Schema.decodeUnknownEffect(ExperimentModel.ExperimentReadFileInput);

it.effect(
  "registers only the five experiment tools and derives identity from the credential",
  () => {
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const service = ExperimentMcpService.of({
      status: (input) => Effect.sync(() => (calls.push({ method: "status", input }), summary)),
      listFiles: (input) =>
        Effect.sync(() => (calls.push({ method: "listFiles", input }), { files: ["src/a.ts"] })),
      readFile: (input) =>
        Effect.sync(
          () => (calls.push({ method: "readFile", input }), { path: input.path, content: "a" }),
        ),
      apply: (input) =>
        Effect.sync(
          () => (
            calls.push({ method: "apply", input }),
            {
              candidateId: "candidate-1",
              files: input.changes.map((change) => change.path),
            }
          ),
        ),
      evaluate: (input) =>
        Effect.sync(
          () => (
            calls.push({ method: "evaluate", input }),
            {
              outcome: "kept" as const,
              metric: 2,
              metrics: { score: 2 },
              commit: "abc123",
              reason: null,
            }
          ),
        ),
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;

      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
        "experiment_apply",
        "experiment_evaluate",
        "experiment_list_files",
        "experiment_read_file",
        "experiment_status",
      ]);

      yield* server
        .callTool({ name: "experiment_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      yield* server
        .callTool({
          name: "experiment_apply",
          arguments: {
            hypothesis: "Make the hot path linear",
            changes: [{ path: "src/a.ts", content: "replacement" }],
          },
        })
        .pipe(
          Effect.provideService(McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(calls).toEqual([
        { method: "status", input: identity },
        {
          method: "apply",
          input: {
            ...identity,
            hypothesis: "Make the hot path linear",
            changes: [{ path: "src/a.ts", content: "replacement" }],
          },
        },
      ]);
    }).pipe(
      Effect.provide(
        ExperimentToolkitRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(Layer.succeed(ExperimentMcpService, service)),
        ),
      ),
    );
  },
);

it.effect("rejects credentials without the exact experiment-only binding", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "experiment_status", arguments: {} }).pipe(
      Effect.provideService(McpInvocationContext, {
        ...invocation,
        capabilities: new Set(["experiment", "preview"] as const),
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("MCP credential is not bound to an experiment run.");
  }).pipe(
    Effect.provide(
      ExperimentToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(
          Layer.succeed(
            ExperimentMcpService,
            ExperimentMcpService.of({
              status: () => Effect.die("must not call"),
              listFiles: () => Effect.die("must not call"),
              readFile: () => Effect.die("must not call"),
              apply: () => Effect.die("must not call"),
              evaluate: () => Effect.die("must not call"),
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect(
  "passes credential generation to the authoritative service and rejects a stale rearm",
  () => {
    const acceptedGenerations: Array<number> = [];
    const service = ExperimentMcpService.of({
      status: (input) =>
        input.generation === 4
          ? Effect.sync(() => (acceptedGenerations.push(input.generation), summary))
          : Effect.fail(
              new ExperimentModel.ExperimentMcpError({
                code: "PROVIDER_EXPERIMENT_UNAUTHORIZED",
                message: "Experiment credential generation is stale.",
              }),
            ),
      listFiles: () => Effect.die("unused"),
      readFile: () => Effect.die("unused"),
      apply: () => Effect.die("unused"),
      evaluate: () => Effect.die("unused"),
    });

    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const stale = yield* server
        .callTool({ name: "experiment_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(stale.isError).toBe(true);
      expect(JSON.stringify(stale)).toContain("Experiment credential generation is stale.");

      const currentInvocation = {
        ...invocation,
        experiment: { ...invocation.experiment, generation: 4 },
      };
      const current = yield* server
        .callTool({ name: "experiment_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext, currentInvocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(current.isError).not.toBe(true);
      expect(acceptedGenerations).toEqual([4]);

      const callerSuppliedGeneration = yield* server
        .callTool({ name: "experiment_status", arguments: { generation: 4 } })
        .pipe(
          Effect.provideService(McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.result,
        );
      expect(callerSuppliedGeneration._tag).toBe("Failure");
      expect(acceptedGenerations).toEqual([4]);
    }).pipe(
      Effect.provide(
        ExperimentToolkitRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(Layer.succeed(ExperimentMcpService, service)),
        ),
      ),
    );
  },
);

it.effect("rejects absolute, parent-traversing, and backslash paths", () =>
  Effect.gen(function* () {
    for (const path of ["/etc/passwd", "../secret", "src/../../secret", "src\\secret"]) {
      expect(
        yield* decodeReadFileInput({ path }).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        ),
      ).toBe(false);
    }
    expect(
      yield* decodeReadFileInput({
        path: "src/worker.ts",
        offset: 10,
        limit: 65_536,
      }).pipe(Effect.as(true)),
    ).toBe(true);
  }),
);
