import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type ThreadExperimentSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  getThreadExperiment,
  previewThreadExperiment,
  startThreadExperiment,
} from "./threadExperiments.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const summary: ThreadExperimentSummary = {
  runId: "run-1",
  configDigest: "a".repeat(64),
  phase: "ready",
  metric: { name: "score", direction: "maximize", minimumImprovement: 0.1 },
  experimentsRun: 0,
  experimentsKept: 0,
  experimentsRestored: 0,
  baselineMetric: null,
  bestMetric: null,
  lastMetric: null,
  elapsedSeconds: 0,
  maxExperiments: 8,
  maxTotalSeconds: 600,
  lastError: null,
};

describe("thread experiment operations", () => {
  it.effect("calls the preview, start, and get RPCs with only their typed inputs", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [string, unknown]> = [];
      const client = {
        [WS_METHODS.threadExperimentPreview]: (input: unknown) =>
          Effect.sync(() => {
            calls.push([WS_METHODS.threadExperimentPreview, input]);
            return {
              objective: "Improve score",
              confirmationId: "confirmation-1",
              expiresAt: "2026-09-07T04:30:00.000Z",
              cwd: "/workspace/t3code",
              branch: "experiment/score",
              head: "0123456789abcdef0123456789abcdef01234567",
              configDigest: "a".repeat(64),
              approvedFiles: ["src/score.ts"],
              provider: {
                instanceId: "codex",
                driver: "codex",
                supported: true,
                reason: null,
              },
              evaluator: {
                argv: ["node", "score.mjs"],
                metric: summary.metric,
              },
              checks: [{ name: "typecheck", argv: ["pnpm", "typecheck"] }],
              limits: {
                maxExperiments: 8,
                maxTotalSeconds: 600,
                evaluatorTimeoutSeconds: 60,
                checkTimeoutSeconds: 120,
                maxEvaluatorOutputBytes: 1_024,
                maxCheckOutputBytes: 1_024,
                maxFilesPerApply: 2,
                maxBytesPerFile: 4_096,
                maxTotalApplyBytes: 8_192,
              },
            };
          }),
        [WS_METHODS.threadExperimentStart]: (input: unknown) =>
          Effect.sync(() => {
            calls.push([WS_METHODS.threadExperimentStart, input]);
            return summary;
          }),
        [WS_METHODS.threadExperimentGet]: (input: unknown) =>
          Effect.sync(() => {
            calls.push([WS_METHODS.threadExperimentGet, input]);
            return summary;
          }),
      } as unknown as WsRpcProtocolClient;
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: (input) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const threadId = ThreadId.make("thread-1");

      yield* Effect.all(
        [
          previewThreadExperiment({ threadId, objective: "Improve score" }),
          startThreadExperiment({
            threadId,
            objective: "Improve score",
            confirmationId: "confirmation-1",
          }),
          getThreadExperiment({ threadId }),
        ],
        { concurrency: 1 },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(calls).toEqual([
        [WS_METHODS.threadExperimentPreview, { threadId: "thread-1", objective: "Improve score" }],
        [
          WS_METHODS.threadExperimentStart,
          {
            threadId: "thread-1",
            objective: "Improve score",
            confirmationId: "confirmation-1",
          },
        ],
        [WS_METHODS.threadExperimentGet, { threadId: "thread-1" }],
      ]);
    }),
  );
});
