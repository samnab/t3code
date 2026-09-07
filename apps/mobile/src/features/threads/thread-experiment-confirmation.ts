import type { EnvironmentId, ThreadExperimentPreview, ThreadId } from "@t3tools/contracts";

export interface ThreadExperimentConfirmationState {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly objective: string;
  readonly preview: ThreadExperimentPreview;
  readonly confirming: boolean;
  readonly error: string | null;
}

export interface ThreadExperimentPreviewRequest {
  readonly id: number;
  readonly threadKey: string;
}

export function isCurrentThreadExperimentPreviewRequest(
  request: ThreadExperimentPreviewRequest,
  currentRequest: ThreadExperimentPreviewRequest | null,
  currentThreadKey: string | null,
): boolean {
  return (
    currentRequest?.id === request.id &&
    currentRequest.threadKey === request.threadKey &&
    currentThreadKey === request.threadKey
  );
}

export function isThreadExperimentConfirmationForThread(
  state: ThreadExperimentConfirmationState,
  threadKey: string | null,
): boolean {
  return state.threadKey === threadKey;
}

export type ThreadExperimentConfirmationAction =
  | {
      readonly type: "open";
      readonly threadKey: string;
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
        threadKey: action.threadKey,
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

export function formatThreadExperimentArgv(argv: ReadonlyArray<string>): string {
  return argv.map((argument) => JSON.stringify(argument)).join(" ");
}
