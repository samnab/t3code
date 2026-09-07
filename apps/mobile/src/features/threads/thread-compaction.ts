import type { ServerProvider } from "@t3tools/contracts";

export interface ThreadCompactionControl {
  /** False hides the control (provider does not declare /compact, or an old server). */
  readonly available: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}

/**
 * Resolve the composer's Compact context control. Availability now comes
 * from the provider's declared `/compact` slash command — the server decides
 * internally whether that dispatches a turn or a native call, so the client
 * always sends "/compact" as an ordinary message. The rest of the matrix
 * mirrors web's guards: session busy, pending turn work, a dirty draft, and
 * an in-flight compact. All inputs are plain values so the matrix stays
 * testable.
 */
export function resolveThreadCompactionControl(input: {
  readonly provider: ServerProvider | null;
  readonly sessionStatus: string | null | undefined;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly draftHasContent: boolean;
  readonly compactInFlight: boolean;
}): ThreadCompactionControl {
  const available =
    input.provider?.slashCommands.some((command) => command.name === "compact") ?? false;
  if (!available) {
    return { available: false, disabled: true, disabledReason: null };
  }
  if (input.sessionStatus === "running" || input.sessionStatus === "starting") {
    return {
      available,
      disabled: true,
      disabledReason: "Stop the running turn before compacting.",
    };
  }
  if (input.pendingApprovalCount > 0 || input.pendingUserInputCount > 0) {
    return {
      available,
      disabled: true,
      disabledReason: "Resolve the pending request before compacting.",
    };
  }
  if (input.draftHasContent) {
    return {
      available,
      disabled: true,
      disabledReason: "Send or clear your message before compacting.",
    };
  }
  if (input.compactInFlight) {
    return { available, disabled: true, disabledReason: "Compacting…" };
  }
  return { available, disabled: false, disabledReason: null };
}
