import {
  ApprovalRequestId,
  type OrchestrationThreadActivity,
  ProviderApprovalOption,
  ProviderRequestKind,
  UserInputQuestion,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
}

export interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
}

/** The question/answer pair rendered in a thread's activity history. */
export interface UserInputHistory {
  readonly requestId: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  /** `null` means the request is still waiting for a response. */
  readonly answers: Readonly<Record<string, unknown>> | null;
}

const isRequestId = Schema.is(ApprovalRequestId);
const isProviderRequestKind = Schema.is(ProviderRequestKind);
const isProviderApprovalOption = Schema.is(ProviderApprovalOption);
const QuestionOption = Schema.Struct({
  ...UserInputQuestion.fields.options.value.fields,
  label: Schema.String,
});
const isQuestionOption = Schema.is(QuestionOption);
// Native question IDs and option labels can be answer keys. Do not trim them.
const decodeQuestion = Schema.decodeUnknownOption(
  Schema.Struct({
    ...UserInputQuestion.fields,
    id: Schema.String,
    header: Schema.String,
    question: Schema.String,
    options: Schema.Array(QuestionOption),
  }),
);

/** Older activities use native request types instead of a request kind. */
export function requestKindFromRequestType(requestType: unknown): ProviderRequestKind | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    default:
      return null;
  }
}

function parseQuestions(value: unknown): UserInputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((question) => {
    if (!Predicate.isObject(question) || !Array.isArray(question.options)) return [];
    const options = question.options.filter(isQuestionOption);
    if (options.length === 0 && question.allowCustomAnswer === false) return [];
    const parsed = decodeQuestion({
      id: question.id,
      header: question.header,
      question: question.question,
      options,
      multiSelect: question.multiSelect === true,
      ...(typeof question.allowCustomAnswer === "boolean"
        ? { allowCustomAnswer: question.allowCustomAnswer }
        : {}),
    });
    return Option.isSome(parsed) ? [parsed.value] : [];
  });
}

const requestActivityKinds = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

/** Returns the request id carried by a canonical user-input lifecycle activity. */
export function userInputRequestId(
  activity: Pick<OrchestrationThreadActivity, "kind" | "payload">,
): string | null {
  if (activity.kind !== "user-input.requested" && activity.kind !== "user-input.resolved") {
    return null;
  }
  if (!Predicate.isObject(activity.payload) || typeof activity.payload.requestId !== "string") {
    return null;
  }
  return activity.payload.requestId;
}

/**
 * Pairs canonical question requests with their eventual answers while keeping
 * the request's identity and position available to the history renderers.
 * Requests and resolutions are collected independently so a page arriving
 * out of order can still settle the original question row.
 */
export function deriveUserInputHistory(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, UserInputHistory> {
  const requested = new Map<string, UserInputHistory>();
  const resolved = new Map<string, Readonly<Record<string, unknown>>>();

  for (const activity of activities) {
    const requestId = userInputRequestId(activity);
    if (requestId === null) continue;
    const payload = Predicate.isObject(activity.payload) ? activity.payload : undefined;
    if (!payload) continue;

    if (activity.kind === "user-input.requested") {
      const questions = parseQuestions(payload.questions);
      if (questions.length === 0) continue;
      requested.set(requestId, {
        requestId,
        questions,
        answers: resolved.get(requestId) ?? null,
      });
    } else if (Predicate.isObject(payload.answers)) {
      resolved.set(requestId, payload.answers);
      const existing = requested.get(requestId);
      if (existing) {
        requested.set(requestId, { ...existing, answers: payload.answers });
      }
    }
  }

  return requested;
}

/** Formats native choice values, custom text, and multi-select answers alike. */
export function formatUserInputAnswer(question: UserInputQuestion, value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  const formatted = values.flatMap((answer) => {
    if (answer === null || answer === undefined) return [];
    const option = question.options.find(
      (candidate) =>
        candidate.value === answer || (candidate.value === undefined && candidate.label === answer),
    );
    if (option) return [option.label];
    if (typeof answer === "string") return [answer];
    if (typeof answer === "number" || typeof answer === "boolean") return [String(answer)];
    try {
      const serialized = JSON.stringify(answer);
      return serialized === undefined ? [String(answer)] : [serialized];
    } catch {
      return [String(answer)];
    }
  });
  return formatted.length > 0 ? formatted.join(", ") : "No answer";
}

// The server reports a stale or unknown request through the failure text.
// A failed reply with any other text stays open so the user can retry.
const staleRequestFailureDetails = {
  "provider.approval.respond.failed": [
    "stale pending approval request",
    "unknown pending approval request",
    "unknown pending permission request",
    "unknown pending codex approval request",
  ],
  "provider.user-input.respond.failed": [
    "stale pending user-input request",
    "unknown pending user-input request",
    "unknown pending user input request",
    "unknown pending codex user input request",
  ],
} as const;

function isStaleRequestFailure(
  kind: keyof typeof staleRequestFailureDetails,
  payload: Record<string, unknown>,
): boolean {
  const detail = typeof payload.detail === "string" ? payload.detail.toLowerCase() : "";
  return staleRequestFailureDetails[kind].some((fragment) => detail.includes(fragment));
}

/** Reduces request state once for web, desktop, and mobile. Layout stays with each client. */
export function derivePendingRequests(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const approvals = new Map<ApprovalRequestId, PendingApproval>();
  const userInputs = new Map<ApprovalRequestId, PendingUserInput>();
  const closedApprovals = new Set<ApprovalRequestId>();
  const closedUserInputs = new Set<ApprovalRequestId>();

  // Request IDs are unique. A terminal event stays final even when provider
  // sequences and server-generated activities arrive in a different order.
  for (const activity of activities) {
    if (!requestActivityKinds.has(activity.kind)) continue;
    const payload = Predicate.isObject(activity.payload) ? activity.payload : undefined;
    if (!payload || !isRequestId(payload.requestId)) continue;
    const requestId = payload.requestId;

    if (activity.kind === "approval.requested") {
      if (
        closedApprovals.has(requestId) ||
        payload.requestType === "tool_user_input" ||
        payload.requestType === "auth_tokens_refresh"
      ) {
        continue;
      }
      const requestKind = isProviderRequestKind(payload.requestKind)
        ? payload.requestKind
        : requestKindFromRequestType(payload.requestType);
      const options = Array.isArray(payload.options)
        ? payload.options.filter(isProviderApprovalOption)
        : [];
      approvals.set(requestId, {
        requestId,
        // Older OpenCode approvals do not always include a recognized kind.
        requestKind: requestKind ?? "command",
        createdAt: activity.createdAt,
        ...(typeof payload.detail === "string" && payload.detail ? { detail: payload.detail } : {}),
        ...(typeof payload.appName === "string" && payload.appName
          ? { appName: payload.appName }
          : {}),
        ...(options.length > 0 ? { options } : {}),
      });
    } else if (activity.kind === "user-input.requested") {
      if (closedUserInputs.has(requestId)) continue;
      const questions = parseQuestions(payload.questions);
      if (questions.length === 0) continue;
      userInputs.set(requestId, { requestId, createdAt: activity.createdAt, questions });
    } else if (
      activity.kind === "approval.resolved" ||
      (activity.kind === "provider.approval.respond.failed" &&
        isStaleRequestFailure(activity.kind, payload))
    ) {
      closedApprovals.add(requestId);
      approvals.delete(requestId);
    } else if (
      activity.kind === "user-input.resolved" ||
      (activity.kind === "provider.user-input.respond.failed" &&
        isStaleRequestFailure(activity.kind, payload))
    ) {
      closedUserInputs.add(requestId);
      userInputs.delete(requestId);
    }
  }

  const byCreatedAt = (
    left: { readonly createdAt: string },
    right: { readonly createdAt: string },
  ) => left.createdAt.localeCompare(right.createdAt);
  return {
    approvals: [...approvals.values()].sort(byCreatedAt),
    userInputs: [...userInputs.values()].sort(byCreatedAt),
  };
}
