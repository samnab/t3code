import type { ServerProvider } from "@t3tools/contracts";

export interface ExecutionGoalControl {
  /** Server-declared capability; false hides the toolbar entry entirely. */
  readonly visible: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}

/**
 * Resolves the composer toolbar's Codex execution-goal entry from the
 * server-declared provider capability plus a live session and connection.
 * The provider goal is read straight from the live session, so there is
 * nothing to queue offline: both guards block the open instead.
 */
export function resolveExecutionGoalControl(input: {
  readonly provider: ServerProvider | null;
  readonly sessionPresent: boolean;
  readonly connected: boolean;
}): ExecutionGoalControl {
  if (input.provider?.executionGoal !== "native") {
    return { visible: false, disabled: true, disabledReason: null };
  }
  if (!input.connected) {
    return {
      visible: true,
      disabled: true,
      disabledReason: "Reconnect before opening Codex's execution goal.",
    };
  }
  if (!input.sessionPresent) {
    return {
      visible: true,
      disabled: true,
      disabledReason: "Send a message to start this Codex session first.",
    };
  }
  return { visible: true, disabled: false, disabledReason: null };
}
