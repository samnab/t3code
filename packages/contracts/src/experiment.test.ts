import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  THREAD_EXPERIMENT_MAX_APPROVED_FILES,
  ThreadExperimentPreview,
  ThreadExperimentSummary,
} from "./experiment.ts";
import {
  WsThreadExperimentGetRpc,
  WsThreadExperimentPreviewRpc,
  WsThreadExperimentStartRpc,
} from "./rpc.ts";

const decodePreview = Schema.decodeUnknownSync(ThreadExperimentPreview);
const decodePreviewExit = Schema.decodeUnknownExit(ThreadExperimentPreview);
const decodeSummary = Schema.decodeUnknownSync(ThreadExperimentSummary);
const decodeSummaryExit = Schema.decodeUnknownExit(ThreadExperimentSummary);

const validPreview = {
  objective: "Reduce bundle size",
  confirmationId: "confirmation-1",
  expiresAt: "2026-09-07T04:30:00.000Z",
  cwd: "/workspace/t3code",
  branch: "experiment/bundle-size",
  head: "0123456789abcdef0123456789abcdef01234567",
  configDigest: "a".repeat(64),
  approvedFiles: ["apps/web/src/main.tsx"],
  provider: {
    instanceId: "codex",
    driver: "codex",
    supported: true,
    reason: null,
  },
  evaluator: {
    argv: ["node", "scripts/measure.mjs"],
    metric: { name: "bundle bytes", direction: "minimize", minimumImprovement: 1 },
  },
  checks: [{ name: "web typecheck", argv: ["pnpm", "--filter", "web", "typecheck"] }],
  limits: {
    maxExperiments: 8,
    maxTotalSeconds: 3_600,
    evaluatorTimeoutSeconds: 120,
    checkTimeoutSeconds: 300,
    maxEvaluatorOutputBytes: 262_144,
    maxCheckOutputBytes: 262_144,
    maxFilesPerApply: 4,
    maxBytesPerFile: 262_144,
    maxTotalApplyBytes: 524_288,
  },
} as const;

const validSummary = {
  runId: "run-1",
  configDigest: "a".repeat(64),
  phase: "evaluating",
  metric: { name: "bundle bytes", direction: "minimize", minimumImprovement: 1 },
  experimentsRun: 2,
  experimentsKept: 1,
  experimentsRestored: 1,
  baselineMetric: 100_000,
  bestMetric: 90_000,
  lastMetric: 95_000,
  elapsedSeconds: 37.5,
  maxExperiments: 8,
  maxTotalSeconds: 3_600,
  lastError: null,
} as const;

describe("thread experiment contracts", () => {
  it("decodes bounded previews and summaries", () => {
    expect(decodePreview(validPreview)).toEqual(validPreview);
    expect(decodeSummary(validSummary)).toEqual(validSummary);
  });

  it("rejects non-finite metrics and unbounded public values", () => {
    expect(
      Exit.isFailure(
        decodeSummaryExit({
          ...validSummary,
          bestMetric: Number.POSITIVE_INFINITY,
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodePreviewExit({
          ...validPreview,
          approvedFiles: Array.from(
            { length: THREAD_EXPERIMENT_MAX_APPROVED_FILES + 1 },
            (_, index) => `src/file-${index}.ts`,
          ),
        }),
      ),
    ).toBe(true);
  });

  it("rejects malformed, extra, and unbounded RPC request values", () => {
    const previewPayload = WsThreadExperimentPreviewRpc.payloadSchema;
    const startPayload = WsThreadExperimentStartRpc.payloadSchema;
    const getPayload = WsThreadExperimentGetRpc.payloadSchema;

    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(previewPayload)({ threadId: "thread-1", objective: "   " }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(previewPayload)({
          threadId: "thread-1",
          objective: "x".repeat(501),
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(startPayload)({
          threadId: "thread-1",
          objective: "Reduce bundle size",
          confirmationId: "confirmation-1",
          evaluator: ["sh", "-c", "arbitrary command"],
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(getPayload)({
          threadId: "thread-1",
          branch: "main",
        }),
      ),
    ).toBe(true);
  });
});
