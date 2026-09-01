import type { ServerProvider } from "@t3tools/contracts";

/** How manual compaction is requested for this thread's provider. */
export type ThreadCompactionMode = "prompt" | "native";

export interface ThreadCompactionControl {
  /** Server-declared mode; null hides the control (unsupported or old server). */
  readonly mode: ThreadCompactionMode | null;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
}

/**
 * Resolve the composer's Compact context control from the server-declared
 * capability plus the same guards web uses: session busy, pending turn work,
 * a dirty draft, a live connection requirement for native dispatch (prompt
 * mode queues like any message), and an in-flight native request. All inputs
 * are plain values so the matrix stays testable.
 */
export function resolveThreadCompactionControl(input: {
  readonly provider: ServerProvider | null;
  readonly sessionStatus: string | null | undefined;
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly draftHasContent: boolean;
  readonly compactInFlight: boolean;
  readonly connected: boolean;
}): ThreadCompactionControl {
  const mode = input.provider?.contextCompaction ?? null;
  if (mode === null) {
    return { mode: null, disabled: true, disabledReason: null };
  }
  if (input.sessionStatus === "running" || input.sessionStatus === "starting") {
    return {
      mode,
      disabled: true,
      disabledReason: "Stop the running turn before compacting.",
    };
  }
  if (input.pendingApprovalCount > 0 || input.pendingUserInputCount > 0) {
    return {
      mode,
      disabled: true,
      disabledReason: "Resolve the pending request before compacting.",
    };
  }
  if (input.draftHasContent) {
    return {
      mode,
      disabled: true,
      disabledReason: "Send or clear your message before compacting.",
    };
  }
  if (input.compactInFlight) {
    return { mode, disabled: true, disabledReason: "Compacting…" };
  }
  // Native compaction is a direct dispatch with no offline queue; the /compact
  // prompt is an ordinary message and queues like any other.
  if (mode === "native" && !input.connected) {
    return {
      mode,
      disabled: true,
      disabledReason: "Reconnect before compacting.",
    };
  }
  return { mode, disabled: false, disabledReason: null };
}
