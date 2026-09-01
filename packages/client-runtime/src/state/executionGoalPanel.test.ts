import { EnvironmentId, ThreadId, type ProviderExecutionGoalSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createExecutionGoalPanelController,
  executionGoalCanClear,
  executionGoalCanPause,
  executionGoalCanRefresh,
  executionGoalDurationLabel,
  executionGoalErrorCopy,
  executionGoalPanelReducer,
  executionGoalStatusLabel,
  executionGoalTokensLabel,
  toExecutionGoalPanelError,
  type ExecutionGoalPanelState,
} from "./executionGoalPanel.ts";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadKey = "environment-1:thread-1";
const otherThreadKey = "environment-2:thread-2";

const snapshot = (
  overrides?: Partial<ProviderExecutionGoalSnapshot>,
): ProviderExecutionGoalSnapshot => ({
  threadId,
  objective: "ship the login fix",
  status: "active",
  tokensUsed: 12345,
  tokenBudget: 100000,
  timeUsedSeconds: 200,
  createdAt: "2026-04-15T17:00:00.000Z",
  updatedAt: "2026-04-15T17:01:00.000Z",
  ...overrides,
});

function openPanel(): ExecutionGoalPanelState {
  return executionGoalPanelReducer(null, {
    type: "open",
    threadKey,
    environmentId,
    threadId,
  })!;
}

describe("executionGoalPanelReducer", () => {
  it("opens in loading and settles on the fetched goal", () => {
    const panel = openPanel();
    expect(panel.status).toBe("loading");
    const ready = executionGoalPanelReducer(panel, {
      type: "fetchSuccess",
      threadKey,
      goal: snapshot(),
    })!;
    expect(ready.status).toBe("ready");
    expect(ready.snapshot?.objective).toBe("ship the login fix");
  });

  it("ignores late replies naming another thread", () => {
    const panel = openPanel();
    const crossed = executionGoalPanelReducer(panel, {
      type: "fetchSuccess",
      threadKey: otherThreadKey,
      goal: snapshot(),
    })!;
    expect(crossed).toBe(panel);
    const failure = executionGoalPanelReducer(panel, {
      type: "fetchFailure",
      threadKey: otherThreadKey,
      error: { reason: "provider-error", message: "boom" },
    })!;
    expect(failure).toBe(panel);
  });

  it("keeps the prior snapshot visible when a refetch fails", () => {
    let panel = executionGoalPanelReducer(openPanel(), {
      type: "fetchSuccess",
      threadKey,
      goal: snapshot(),
    })!;
    panel = executionGoalPanelReducer(panel, { type: "beginRefresh", threadKey })!;
    panel = executionGoalPanelReducer(panel, {
      type: "fetchFailure",
      threadKey,
      error: { reason: "offline", message: "not connected" },
    })!;
    expect(panel.status).toBe("error");
    expect(panel.snapshot?.objective).toBe("ship the login fix");
    expect(panel.refreshing).toBe(false);
  });

  it("allows only one pause or clear at a time and resets it via refetch", () => {
    let panel = executionGoalPanelReducer(openPanel(), {
      type: "fetchSuccess",
      threadKey,
      goal: snapshot(),
    })!;
    panel = executionGoalPanelReducer(panel, { type: "beginPause", threadKey })!;
    expect(panel.action).toBe("pausing");
    // A duplicate pause or an interleaved clear must not start.
    expect(executionGoalPanelReducer(panel, { type: "beginClear", threadKey })!.action).toBe(
      "pausing",
    );
    panel = executionGoalPanelReducer(panel, {
      type: "fetchSuccess",
      threadKey,
      goal: snapshot({ status: "paused" }),
    })!;
    expect(panel.action).toBe("none");
    expect(panel.snapshot?.status).toBe("paused");
  });

  it("keeps the panel open with the prior snapshot when pause fails", () => {
    let panel = executionGoalPanelReducer(openPanel(), {
      type: "fetchSuccess",
      threadKey,
      goal: snapshot(),
    })!;
    panel = executionGoalPanelReducer(panel, { type: "beginPause", threadKey })!;
    panel = executionGoalPanelReducer(panel, {
      type: "actionFailure",
      threadKey,
      error: { reason: "provider-error", message: "Codex refused" },
    })!;
    expect(panel.action).toBe("none");
    expect(panel.snapshot?.status).toBe("active");
    expect(panel.error?.message).toBe("Codex refused");
  });

  it("closes only its own thread", () => {
    const panel = openPanel();
    expect(executionGoalPanelReducer(panel, { type: "close", threadKey: otherThreadKey })).toBe(
      panel,
    );
    expect(executionGoalPanelReducer(panel, { type: "close", threadKey })).toBeNull();
  });

  it("guards the action buttons", () => {
    const active = executionGoalPanelReducer(openPanel(), {
      type: "fetchSuccess",
      threadKey,
      goal: snapshot(),
    })!;
    expect(executionGoalCanPause(active)).toBe(true);
    const paused = executionGoalPanelReducer(active, {
      type: "fetchSuccess",
      threadKey,
      goal: snapshot({ status: "paused" }),
    })!;
    expect(executionGoalCanPause(paused)).toBe(false);
    const empty = executionGoalPanelReducer(openPanel(), {
      type: "fetchSuccess",
      threadKey,
      goal: null,
    })!;
    expect(executionGoalCanClear(empty)).toBe(false);
    expect(executionGoalCanPause(empty)).toBe(false);
    const refreshing = executionGoalPanelReducer(active, { type: "beginRefresh", threadKey })!;
    expect(executionGoalCanRefresh(refreshing)).toBe(false);
    expect(executionGoalCanPause(refreshing)).toBe(false);
    expect(executionGoalCanClear(refreshing)).toBe(false);
  });
});

describe("execution goal presentation", () => {
  it("labels every status in words", () => {
    expect(executionGoalStatusLabel("usageLimited")).toBe("Usage limited");
    expect(executionGoalStatusLabel("budgetLimited")).toBe("Budget limited");
    expect(executionGoalStatusLabel("complete")).toBe("Complete");
  });

  it("formats tokens and durations", () => {
    expect(executionGoalTokensLabel(snapshot())).toBe("12,345 / 100,000 tokens");
    const { tokenBudget: _omitted, ...withoutBudget } = snapshot();
    expect(executionGoalTokensLabel(withoutBudget)).toBe("12,345 tokens");
    expect(executionGoalDurationLabel(200)).toBe("3m 20s");
    expect(executionGoalDurationLabel(3900)).toBe("1h 5m");
    expect(executionGoalDurationLabel(0)).toBe("0s");
  });

  it("names the recovery per failure reason", () => {
    expect(executionGoalErrorCopy({ reason: "unsupported", message: "x" }).title).toBe(
      "Provider execution goals unavailable",
    );
    expect(
      executionGoalErrorCopy({ reason: "no-live-session", message: "x" }).description,
    ).toContain("provider session");
    expect(executionGoalErrorCopy({ reason: "offline", message: "x" }).title).toBe(
      "Environment not connected",
    );
    expect(
      executionGoalErrorCopy({
        reason: "provider-error",
        message: "Method not found: thread/goal/get",
      }).title,
    ).toBe("Codex is too old for execution goals");
  });

  it("normalizes command failures into panel errors", () => {
    expect(
      toExecutionGoalPanelError({
        _tag: "ProviderExecutionGoalError",
        threadId,
        reason: "unsupported",
        message: "no goal support",
      }),
    ).toEqual({ reason: "unsupported", message: "no goal support" });
    expect(
      toExecutionGoalPanelError({
        _tag: "EnvironmentRpcUnavailableError",
        environmentId: "environment-1",
        message: "not connected",
      }).reason,
    ).toBe("offline");
    expect(toExecutionGoalPanelError(new Error("boom"))).toEqual({
      reason: "provider-error",
      message: "boom",
    });
  });
});

describe("createExecutionGoalPanelController", () => {
  const target = { threadKey, environmentId, threadId };

  type Result<A> =
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly cause: unknown };

  const success = <A>(value: A): Result<A> => ({ _tag: "Success", value });
  const failure = (cause: unknown): Result<never> => ({ _tag: "Failure", cause });

  function makeHarness(commands?: {
    readonly get?: (input: {
      readonly environmentId: typeof environmentId;
      readonly input: { readonly threadId: typeof threadId };
    }) => Promise<Result<{ readonly goal: ProviderExecutionGoalSnapshot | null }>>;
    readonly pause?: (input: {
      readonly environmentId: typeof environmentId;
      readonly input: { readonly threadId: typeof threadId };
    }) => Promise<Result<unknown>>;
    readonly clear?: (input: {
      readonly environmentId: typeof environmentId;
      readonly input: { readonly threadId: typeof threadId };
    }) => Promise<Result<unknown>>;
  }) {
    const get =
      commands?.get ??
      vi.fn(
        async (): Promise<Result<{ readonly goal: ProviderExecutionGoalSnapshot | null }>> =>
          success({ goal: snapshot() }),
      );
    const pause = commands?.pause ?? vi.fn(async (): Promise<Result<unknown>> => success({}));
    const clear = commands?.clear ?? vi.fn(async (): Promise<Result<unknown>> => success({}));
    let panel: ExecutionGoalPanelState | null = null;
    const dispatch = (action: Parameters<typeof executionGoalPanelReducer>[1]) => {
      panel = executionGoalPanelReducer(panel, action);
    };
    const controller = createExecutionGoalPanelController({
      commands: { get, pause, clear },
      dispatch,
      state: () => panel,
    });
    const openWithGoal = () => {
      dispatch({ type: "open", threadKey, environmentId, threadId });
      dispatch({ type: "fetchSuccess", threadKey, goal: snapshot() });
    };
    return {
      controller,
      commands: { get, pause, clear },
      dispatch,
      openWithGoal,
      panel: () => panel,
    };
  }

  it("fetches on demand and settles the panel", async () => {
    const harness = makeHarness();
    harness.dispatch({ type: "open", threadKey, environmentId, threadId });
    await harness.controller.fetch(target);
    expect(harness.panel()?.status).toBe("ready");
    expect(harness.panel()?.snapshot?.objective).toBe("ship the login fix");
  });

  it("pauses through the pause RPC only, then refetches", async () => {
    const harness = makeHarness();
    harness.openWithGoal();
    await harness.controller.pause();
    expect(harness.commands.pause).toHaveBeenCalledTimes(1);
    expect(harness.commands.pause).toHaveBeenCalledWith({
      environmentId,
      input: { threadId },
    });
    // Refetch after the action: get was called too, and nothing else exists
    // on the controller to call.
    expect(harness.commands.get).toHaveBeenCalledTimes(1);
    expect(harness.commands.clear).not.toHaveBeenCalled();
    expect(harness.panel()?.action).toBe("none");
  });

  it("ignores a duplicate pause while one is in flight", async () => {
    const harness = makeHarness();
    harness.openWithGoal();
    const first = harness.controller.pause();
    await harness.controller.pause();
    await first;
    expect(harness.commands.pause).toHaveBeenCalledTimes(1);
  });

  it("keeps the panel open with the prior snapshot when clear fails", async () => {
    const failingClear = vi.fn(
      async (): Promise<Result<unknown>> =>
        failure({
          _tag: "ProviderExecutionGoalError",
          threadId,
          reason: "provider-error",
          message: "refused",
        }),
    );
    const harness = makeHarness({ clear: failingClear });
    harness.openWithGoal();
    await harness.controller.clear();
    const panel = harness.panel();
    expect(panel?.action).toBe("none");
    expect(panel?.snapshot?.objective).toBe("ship the login fix");
    expect(panel?.error?.message).toBe("refused");
  });

  it("does nothing without an open panel", async () => {
    const harness = makeHarness();
    await harness.controller.pause();
    await harness.controller.clear();
    expect(harness.commands.pause).not.toHaveBeenCalled();
    expect(harness.commands.clear).not.toHaveBeenCalled();
  });
});
