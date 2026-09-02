/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  OrchestrationSubagentControlActionResult,
  OrchestrationSubagentControlCancelInput,
  OrchestrationSubagentControlSteerInput,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ProviderExecutionGoalGetResult,
  RuntimeTaskId,
  SubagentControlError,
  SubagentControlPlaneStatus,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

/**
 * Optional owner-routed subagent control plane for adapters backed by a
 * subagent manager (currently native Pi only). Adapters without one simply
 * leave the member undefined; unsupported adapters stay read-only with an
 * explicit reason.
 */
export interface ProviderSubagentControlPlaneShape<TError> {
  /** Declared status per live session managed by this adapter. */
  readonly status: () => Effect.Effect<ReadonlyArray<SubagentControlPlaneStatus>, TError>;
  readonly steer: (
    input: OrchestrationSubagentControlSteerInput,
  ) => Effect.Effect<OrchestrationSubagentControlActionResult, TError | SubagentControlError>;
  readonly cancel: (
    input: OrchestrationSubagentControlCancelInput,
  ) => Effect.Effect<OrchestrationSubagentControlActionResult, TError | SubagentControlError>;
  /**
   * Phase 1.5 internal routing: deliver one exact `run-upsert-result`
   * (T3 run id for an allocating producer upsert) to the live manager that
   * owns the binding, and confirm its acknowledgement. Never carries
   * transcript bodies. Absent on adapters without an enhanced manager.
   */
  readonly bindingResult?: (
    input: ProviderSubagentBindingResultInput,
  ) => Effect.Effect<OrchestrationSubagentControlActionResult, TError | SubagentControlError>;
}

/** The five routing members of one `run-upsert-result` delivery. */
export interface ProviderSubagentBindingResultInput {
  /** Declared manager id that owns the binding. */
  readonly managerId: string;
  /** T3's opaque run id allocated by the upsert. */
  readonly runId: RuntimeTaskId;
  /** Producer's native run id for the same allocation. */
  readonly nativeRunId: string;
  readonly activationId: string;
  readonly runBirth: string;
  readonly upsertSequence: number;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Ask the provider to compact its own context for one thread. Only
   * adapters whose driver has a native compaction protocol define this;
   * its absence is the truthful "unsupported" answer. Adapters must never
   * abort an active turn: gate on the live session state and fail with a
   * request error instead.
   */
  readonly compactContext?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Provider-native execution-goal reads and actions for one thread. Only
   * adapters whose driver has a native execution-goal protocol (Codex's
   * `thread/goal/*`) define these; absence is the truthful "unsupported"
   * answer. Live-session only: no session means an error, never recovery.
   */
  readonly getExecutionGoal?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderExecutionGoalGetResult, TError>;
  readonly pauseExecutionGoal?: (threadId: ThreadId) => Effect.Effect<void, TError>;
  readonly clearExecutionGoal?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Owner-routed subagent control plane, when the adapter is backed by a
   * subagent manager. Routing across adapters is by declared manager id.
   */
  readonly subagentControlPlane?: ProviderSubagentControlPlaneShape<TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
