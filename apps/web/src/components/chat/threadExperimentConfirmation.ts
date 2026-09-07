import type { EnvironmentId, ThreadExperimentPreview, ThreadId } from "@t3tools/contracts";
import type { ThreadGoalCommand } from "@t3tools/shared/composerTrigger";

export const THREAD_EXPERIMENT_HOST_PERMISSIONS_DISCLOSURE =
  "The evaluator and checks run on this environment's host with your user permissions.";

export function threadExperimentCommandObjective(command: ThreadGoalCommand): string | null {
  return command.action === "experiment" ? command.objective : null;
}

export function threadGoalCommandAttachmentCount(
  command: ThreadGoalCommand,
  imageCount: number,
  fileCount: number,
): number {
  return imageCount + (command.action === "experiment" ? fileCount : 0);
}

export interface ThreadExperimentPreviewRequest {
  readonly id: number;
  readonly threadKey: string;
}

export function isCurrentThreadExperimentPreviewRequest(
  request: ThreadExperimentPreviewRequest,
  currentRequest: ThreadExperimentPreviewRequest | null,
  currentThreadKey: string,
): boolean {
  return (
    currentRequest?.id === request.id &&
    currentRequest.threadKey === request.threadKey &&
    currentThreadKey === request.threadKey
  );
}

export function isThreadExperimentConfirmationForThread(
  state: ThreadExperimentConfirmationState,
  threadKey: string,
): boolean {
  return `${state.environmentId}:${state.threadId}` === threadKey;
}

export interface ThreadExperimentConfirmationState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly objective: string;
  readonly preview: ThreadExperimentPreview;
  readonly confirming: boolean;
  readonly error: string | null;
}

export type ThreadExperimentConfirmationAction =
  | {
      readonly type: "open";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly objective: string;
      readonly preview: ThreadExperimentPreview;
    }
  | { readonly type: "cancel" }
  | { readonly type: "beginConfirm" }
  | { readonly type: "confirmFailure"; readonly error: string };

export function threadExperimentConfirmationReducer(
  state: ThreadExperimentConfirmationState | null,
  action: ThreadExperimentConfirmationAction,
): ThreadExperimentConfirmationState | null {
  switch (action.type) {
    case "open":
      return {
        environmentId: action.environmentId,
        threadId: action.threadId,
        objective: action.objective,
        preview: action.preview,
        confirming: false,
        error: null,
      };
    case "cancel":
      return null;
    case "beginConfirm":
      return state === null || state.confirming
        ? state
        : { ...state, confirming: true, error: null };
    case "confirmFailure":
      return state === null ? state : { ...state, confirming: false, error: action.error };
  }
}

export function canConfirmThreadExperiment(
  state: ThreadExperimentConfirmationState | null,
): state is ThreadExperimentConfirmationState {
  return state !== null && state.preview.provider.supported && !state.confirming;
}

export function threadExperimentStartInput(state: ThreadExperimentConfirmationState) {
  return {
    threadId: state.threadId,
    objective: state.objective,
    confirmationId: state.preview.confirmationId,
  };
}

/** JSON strings keep argument boundaries visible, including whitespace and empty values. */
export function formatThreadExperimentArgv(argv: ReadonlyArray<string>): string {
  return argv.map((argument) => JSON.stringify(argument)).join(" ");
}

export function threadExperimentMetricLabel(
  metric: ThreadExperimentPreview["evaluator"]["metric"],
): string {
  const direction = metric.direction === "maximize" ? "higher is better" : "lower is better";
  return `${metric.name}, ${direction}, minimum improvement ${metric.minimumImprovement}`;
}
