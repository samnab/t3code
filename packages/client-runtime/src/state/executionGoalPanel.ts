import type {
  EnvironmentId,
  ProviderExecutionGoalSnapshot,
  ProviderExecutionGoalStatus,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Pure state for the provider execution-goal panel (Codex-native, read
 * live from the provider session). Deliberately separate from the T3 thread
 * goal: nothing here reads or writes thread metadata, and no provider goal
 * notification feeds it — the panel is pull-only (fetch on open/Refresh,
 * refetch after pause/clear).
 *
 * Like the thread-goal editor, the state carries the thread it was opened
 * for; every settling action names its thread so a late reply can never
 * mutate or reopen a panel opened for another thread.
 */
export interface ExecutionGoalPanelState {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** "loading" until the first fetch settles; later refetches keep "ready". */
  readonly status: "loading" | "ready" | "error";
  readonly snapshot: ProviderExecutionGoalSnapshot | null;
  readonly refreshing: boolean;
  /** Pause/clear guard: only one provider action per panel at a time. */
  readonly action: "none" | "pausing" | "clearing";
  readonly error: ProviderExecutionGoalErrorShape | null;
}

export interface ProviderExecutionGoalErrorShape {
  /** "offline" is client-side only: the environment connection dropped
   * before the RPC could reach the server. */
  readonly reason: "unsupported" | "no-live-session" | "provider-error" | "offline";
  readonly message: string;
}

/** Normalizes any command failure into the panel's error shape. */
export function toExecutionGoalPanelError(cause: unknown): ProviderExecutionGoalErrorShape {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    const tagged = cause as {
      readonly _tag: unknown;
      readonly reason?: unknown;
      readonly message?: unknown;
    };
    if (
      tagged._tag === "ProviderExecutionGoalError" &&
      (tagged.reason === "unsupported" ||
        tagged.reason === "no-live-session" ||
        tagged.reason === "provider-error")
    ) {
      return { reason: tagged.reason, message: String(tagged.message ?? "") };
    }
    if (tagged._tag === "EnvironmentRpcUnavailableError") {
      return {
        reason: "offline",
        message: "This environment is not connected.",
      };
    }
  }
  return {
    reason: "provider-error",
    message: cause instanceof Error ? cause.message : "An unexpected error occurred.",
  };
}

export type ExecutionGoalPanelAction =
  | {
      type: "open";
      threadKey: string;
      environmentId: EnvironmentId;
      threadId: ThreadId;
    }
  | { type: "close"; threadKey?: string }
  | { type: "fetchSuccess"; threadKey: string; goal: ProviderExecutionGoalSnapshot | null }
  | { type: "fetchFailure"; threadKey: string; error: ProviderExecutionGoalErrorShape }
  | { type: "beginRefresh"; threadKey: string }
  | { type: "beginPause"; threadKey: string }
  | { type: "beginClear"; threadKey: string }
  | { type: "actionFailure"; threadKey: string; error: ProviderExecutionGoalErrorShape };

export function executionGoalPanelReducer(
  state: ExecutionGoalPanelState | null,
  action: ExecutionGoalPanelAction,
): ExecutionGoalPanelState | null {
  switch (action.type) {
    case "open":
      return {
        threadKey: action.threadKey,
        environmentId: action.environmentId,
        threadId: action.threadId,
        status: "loading",
        snapshot: null,
        refreshing: false,
        action: "none",
        error: null,
      };
    case "close":
      if (action.threadKey && state?.threadKey !== action.threadKey) return state;
      return null;
    case "fetchSuccess":
      // Late replies for another thread must never mutate this panel.
      // Also settles the in-flight action guard: pause/clear success is
      // completed by the refetch that lands here.
      if (!state || state.threadKey !== action.threadKey) return state;
      return {
        ...state,
        status: "ready",
        snapshot: action.goal,
        refreshing: false,
        action: "none",
        error: null,
      };
    case "fetchFailure":
      // A failed fetch keeps the prior snapshot visible (stale beats blank).
      if (!state || state.threadKey !== action.threadKey) return state;
      return {
        ...state,
        status: "error",
        refreshing: false,
        action: "none",
        error: action.error,
      };
    case "beginRefresh":
      if (!state || state.threadKey !== action.threadKey || state.refreshing) return state;
      return { ...state, refreshing: true };
    case "beginPause":
    case "beginClear": {
      if (!state || state.threadKey !== action.threadKey || state.action !== "none") return state;
      return { ...state, action: action.type === "beginPause" ? "pausing" : "clearing" };
    }
    case "actionFailure":
      // Pause/clear failures keep the panel open with the prior snapshot.
      if (!state || state.threadKey !== action.threadKey || state.action === "none") return state;
      return { ...state, action: "none", error: action.error };
  }
}

/** Pause is offered only for a fetched goal the provider reports active. */
export function executionGoalCanPause(state: ExecutionGoalPanelState): boolean {
  return state.action === "none" && !state.refreshing && state.snapshot?.status === "active";
}

/** Clear is offered whenever a goal is visible and no action is in flight. */
export function executionGoalCanClear(state: ExecutionGoalPanelState): boolean {
  return state.action === "none" && !state.refreshing && state.snapshot !== null;
}

export function executionGoalCanRefresh(state: ExecutionGoalPanelState): boolean {
  return !state.refreshing && state.action === "none";
}

/** Textual status labels — never color-only status in the UI. */
const EXECUTION_GOAL_STATUS_LABELS: Readonly<Record<ProviderExecutionGoalStatus, string>> = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limited",
  budgetLimited: "Budget limited",
  complete: "Complete",
};

export function executionGoalStatusLabel(status: ProviderExecutionGoalStatus): string {
  return EXECUTION_GOAL_STATUS_LABELS[status];
}

/**
 * Recovery copy per failure reason. A provider error that smells like
 * JSON-RPC method-not-found names the real fix: update the Codex install —
 * the server never downgrades the capability based on it.
 */
export function executionGoalErrorCopy(error: ProviderExecutionGoalErrorShape): {
  readonly title: string;
  readonly description: string;
} {
  switch (error.reason) {
    case "unsupported":
      return {
        title: "Provider execution goals unavailable",
        description:
          "This thread's provider does not expose native execution goals. Codex threads on a current T3 Code server support them.",
      };
    case "no-live-session":
      return {
        title: "No live provider session",
        description:
          "Send a message to start this thread's provider session, then reopen the execution goal panel.",
      };
    case "offline":
      return {
        title: "Environment not connected",
        description: "Reconnect to this environment, then refresh the execution goal.",
      };
    default:
      if (/method not found|-32601/i.test(error.message)) {
        return {
          title: "Codex is too old for execution goals",
          description: "Update the Codex CLI on this machine, then reopen the panel.",
        };
      }
      return {
        title: "Codex execution goal request failed",
        description: error.message,
      };
  }
}

/** Compact token usage line; omitted when the provider reports no budget. */
export function executionGoalTokensLabel(snapshot: ProviderExecutionGoalSnapshot): string {
  const used = snapshot.tokensUsed.toLocaleString();
  return snapshot.tokenBudget != null
    ? `${used} / ${snapshot.tokenBudget.toLocaleString()} tokens`
    : `${used} tokens`;
}

/** Time-used line, e.g. "3m 20s" / "1h 5m". */
export function executionGoalDurationLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

type PanelCommandResult<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: unknown };

/** The ONLY operations the execution-goal panel can perform: the three
 * live-provider RPCs. It structurally accepts atom commands, so wiring it is
 * the proof that no thread-metadata or turn-start call can leak in. */
export interface ExecutionGoalPanelCommands {
  readonly get: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  }) => Promise<PanelCommandResult<{ readonly goal: ProviderExecutionGoalSnapshot | null }>>;
  readonly pause: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  }) => Promise<PanelCommandResult<unknown>>;
  readonly clear: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  }) => Promise<PanelCommandResult<unknown>>;
}

export interface ExecutionGoalPanelTarget {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/**
 * Pull-only controller shared by web and mobile: fetch on open/Refresh,
 * refetch after a successful pause/clear, keep the panel open on failure.
 * Duplicate actions are guarded by the reducer's single-action slot.
 */
export function createExecutionGoalPanelController(input: {
  readonly commands: ExecutionGoalPanelCommands;
  readonly dispatch: (action: ExecutionGoalPanelAction) => void;
  readonly state: () => ExecutionGoalPanelState | null;
}) {
  const fetch = async (target: ExecutionGoalPanelTarget) => {
    const result = await input.commands.get({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    if (result._tag === "Failure") {
      input.dispatch({
        type: "fetchFailure",
        threadKey: target.threadKey,
        error: toExecutionGoalPanelError(result.cause),
      });
      return;
    }
    input.dispatch({ type: "fetchSuccess", threadKey: target.threadKey, goal: result.value.goal });
  };

  const runAction = async (
    action: "pause" | "clear",
    command: ExecutionGoalPanelCommands["pause"],
  ) => {
    const state = input.state();
    if (!state) return;
    input.dispatch({
      type: action === "pause" ? "beginPause" : "beginClear",
      threadKey: state.threadKey,
    });
    const result = await command({
      environmentId: state.environmentId,
      input: { threadId: state.threadId },
    });
    if (result._tag === "Failure") {
      input.dispatch({
        type: "actionFailure",
        threadKey: state.threadKey,
        error: toExecutionGoalPanelError(result.cause),
      });
      return;
    }
    // Action accepted: refetch so the panel shows the provider's own view.
    input.dispatch({ type: "beginRefresh", threadKey: state.threadKey });
    await fetch(state);
  };

  return {
    fetch,
    pause: () => {
      const state = input.state();
      if (state !== null && executionGoalCanPause(state)) {
        return runAction("pause", input.commands.pause);
      }
      return Promise.resolve();
    },
    clear: () => {
      const state = input.state();
      if (state !== null && executionGoalCanClear(state)) {
        return runAction("clear", input.commands.clear);
      }
      return Promise.resolve();
    },
  };
}
