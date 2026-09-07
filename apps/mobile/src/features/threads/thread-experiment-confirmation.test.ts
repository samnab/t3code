import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadExperimentPreview,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_EXPERIMENT_HOST_PERMISSIONS_DISCLOSURE,
  canConfirmThreadExperiment,
  isCurrentThreadExperimentPreviewRequest,
  isThreadExperimentConfirmationForThread,
  threadExperimentConfirmationReducer,
  threadExperimentStartInput,
} from "./thread-experiment-confirmation";

const preview: ThreadExperimentPreview = {
  objective: "Reduce startup time",
  confirmationId: "confirm-1",
  expiresAt: "2026-09-07T02:00:00.000Z",
  cwd: "/repo",
  branch: "experiment/startup",
  head: "abc123",
  configDigest: "sha256:config",
  approvedFiles: ["apps/mobile/src/main.tsx"],
  provider: {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    supported: true,
    reason: null,
  },
  evaluator: {
    argv: ["vp", "bench", "startup"],
    metric: { name: "milliseconds", direction: "minimize", minimumImprovement: 5 },
  },
  checks: [{ name: "typecheck", argv: ["vp", "run", "typecheck"] }],
  limits: {
    maxExperiments: 8,
    maxTotalSeconds: 900,
    evaluatorTimeoutSeconds: 60,
    checkTimeoutSeconds: 120,
    maxEvaluatorOutputBytes: 65_536,
    maxCheckOutputBytes: 65_536,
    maxFilesPerApply: 4,
    maxBytesPerFile: 131_072,
    maxTotalApplyBytes: 262_144,
  },
};

function openState() {
  return threadExperimentConfirmationReducer(null, {
    type: "open",
    threadKey: "env-1:thread-1",
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    objective: preview.objective,
    preview,
  });
}

describe("mobile experiment confirmation", () => {
  it("discloses where evaluator and check commands run", () => {
    expect(THREAD_EXPERIMENT_HOST_PERMISSIONS_DISCLOSURE).toBe(
      "The evaluator and checks run on this environment's host with your user permissions.",
    );
  });

  it("cancels without consuming the preview", () => {
    expect(threadExperimentConfirmationReducer(openState(), { type: "cancel" })).toBeNull();
  });

  it("keeps the reviewed values after a stale confirmation error", () => {
    const confirming = threadExperimentConfirmationReducer(openState(), {
      type: "beginConfirm",
    });
    const failed = threadExperimentConfirmationReducer(confirming, {
      type: "confirmFailure",
      error: "Preview expired",
    });
    expect(failed).toMatchObject({
      objective: "Reduce startup time",
      preview,
      error: "Preview expired",
      confirming: false,
    });
  });

  it("uses the one-shot id and disables duplicate confirmation", () => {
    const state = openState();
    if (!state) throw new Error("Expected an open confirmation");
    expect(threadExperimentStartInput(state)).toEqual({
      threadId: ThreadId.make("thread-1"),
      objective: "Reduce startup time",
      confirmationId: "confirm-1",
    });
    expect(
      canConfirmThreadExperiment(
        threadExperimentConfirmationReducer(state, { type: "beginConfirm" }),
      ),
    ).toBe(false);
  });

  it("rejects a preview response after switching threads", () => {
    const request = { id: 4, threadKey: "env-1:thread-1" };
    expect(isCurrentThreadExperimentPreviewRequest(request, request, "env-1:thread-1")).toBe(true);
    expect(isCurrentThreadExperimentPreviewRequest(request, request, "env-1:thread-2")).toBe(false);
    expect(
      isCurrentThreadExperimentPreviewRequest(
        request,
        { id: 5, threadKey: "env-1:thread-2" },
        "env-1:thread-2",
      ),
    ).toBe(false);
  });

  it("refuses to confirm a preview owned by another selected thread", () => {
    const state = openState();
    if (!state) throw new Error("Expected an open confirmation");
    expect(isThreadExperimentConfirmationForThread(state, "env-1:thread-1")).toBe(true);
    expect(isThreadExperimentConfirmationForThread(state, "env-1:thread-2")).toBe(false);
  });
});
