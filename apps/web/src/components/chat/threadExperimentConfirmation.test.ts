import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ThreadExperimentPreview,
} from "@t3tools/contracts";

import {
  canConfirmThreadExperiment,
  formatThreadExperimentArgv,
  isCurrentThreadExperimentPreviewRequest,
  isThreadExperimentConfirmationForThread,
  threadGoalCommandAttachmentCount,
  threadExperimentCommandObjective,
  threadExperimentConfirmationReducer,
  threadExperimentStartInput,
} from "./threadExperimentConfirmation";

const preview: ThreadExperimentPreview = {
  objective: "Reduce startup time",
  confirmationId: "confirm-1",
  expiresAt: "2026-09-07T02:00:00.000Z",
  cwd: "/repo",
  branch: "experiment/startup",
  head: "abc123",
  configDigest: "sha256:config",
  approvedFiles: ["apps/web/src/main.tsx"],
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
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    objective: preview.objective,
    preview,
  });
}

describe("thread experiment confirmation", () => {
  it("cancels without changing the reviewed objective", () => {
    const state = openState();
    expect(state?.objective).toBe("Reduce startup time");
    expect(
      threadExperimentConfirmationReducer(state, {
        type: "cancel",
      }),
    ).toBeNull();
  });

  it("leaves ordinary goal commands on the existing path", () => {
    expect(threadExperimentCommandObjective({ action: "show" })).toBeNull();
    expect(threadExperimentCommandObjective({ action: "clear" })).toBeNull();
    expect(threadExperimentCommandObjective({ action: "set", goal: "Ship it" })).toBeNull();
    expect(
      threadExperimentCommandObjective({
        action: "experiment",
        objective: "Reduce startup time",
      }),
    ).toBe("Reduce startup time");
    expect(threadGoalCommandAttachmentCount({ action: "set", goal: "Ship it" }, 0, 1)).toBe(0);
    expect(
      threadGoalCommandAttachmentCount(
        { action: "experiment", objective: "Reduce startup time" },
        0,
        1,
      ),
    ).toBe(1);
  });

  it("rejects a preview response after the route or request generation changes", () => {
    const request = { id: 4, threadKey: "env-1:thread-1" };
    expect(isCurrentThreadExperimentPreviewRequest(request, request, "env-1:thread-1")).toBe(true);
    expect(
      isCurrentThreadExperimentPreviewRequest(
        request,
        { id: 5, threadKey: "env-1:thread-2" },
        "env-1:thread-2",
      ),
    ).toBe(false);
    expect(isCurrentThreadExperimentPreviewRequest(request, request, "env-1:thread-2")).toBe(false);
  });

  it("refuses to confirm a preview owned by another route", () => {
    const state = openState();
    if (!state) throw new Error("Expected an open confirmation");
    expect(isThreadExperimentConfirmationForThread(state, "env-1:thread-1")).toBe(true);
    expect(isThreadExperimentConfirmationForThread(state, "env-1:thread-2")).toBe(false);
  });

  it("keeps the preview and objective when a stale confirmation fails", () => {
    const confirming = threadExperimentConfirmationReducer(openState(), {
      type: "beginConfirm",
    });
    const failed = threadExperimentConfirmationReducer(confirming, {
      type: "confirmFailure",
      error: "This preview expired. Review the current configuration and try again.",
    });

    expect(failed).toMatchObject({
      objective: "Reduce startup time",
      preview,
      confirming: false,
      error: "This preview expired. Review the current configuration and try again.",
    });
  });

  it("sends the reviewed objective and one-shot confirmation id once", () => {
    const state = openState();
    if (!state) throw new Error("Expected an open confirmation");
    expect(threadExperimentStartInput(state)).toEqual({
      threadId: ThreadId.make("thread-1"),
      objective: "Reduce startup time",
      confirmationId: "confirm-1",
    });

    const confirming = threadExperimentConfirmationReducer(state, { type: "beginConfirm" });
    expect(canConfirmThreadExperiment(confirming)).toBe(false);
    expect(threadExperimentConfirmationReducer(confirming, { type: "beginConfirm" })).toBe(
      confirming,
    );
  });

  it("shows exact argv boundaries", () => {
    expect(formatThreadExperimentArgv(["vp", "bench name", ""])).toBe('"vp" "bench name" ""');
  });
});
