import type {
  OptimizerId,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

export interface OptimizerAttachmentSnapshot {
  readonly providerInstanceId: string;
  readonly createdAt: string;
  readonly configured: readonly OptimizerId[];
  readonly attached: readonly OptimizerId[];
  readonly ready: readonly OptimizerId[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isOptimizerId(value: unknown): value is OptimizerId {
  return value === "rtk" || value === "headroom" || value === "cbm";
}

function optimizerIds(value: unknown): readonly OptimizerId[] {
  return Array.isArray(value) ? value.filter(isOptimizerId) : [];
}

/** Parses the durable session attachment activity without trusting unknown payload fields. */
export function optimizerAttachmentFromActivity(
  activity: OrchestrationThreadActivity,
): OptimizerAttachmentSnapshot | null {
  if (activity.kind !== "optimizer_attached") return null;
  const payload = asRecord(activity.payload);
  const session = asRecord(payload?.session);
  const providerInstanceId = asNonEmptyString(session?.providerInstanceId);
  const createdAt = asNonEmptyString(session?.createdAt);
  if (providerInstanceId === null || createdAt === null) return null;

  return {
    providerInstanceId,
    createdAt,
    configured: optimizerIds(payload?.configured),
    attached: optimizerIds(payload?.attached),
    ready: optimizerIds(payload?.ready),
  };
}

function isLaterActivity(
  candidate: OrchestrationThreadActivity,
  current: OrchestrationThreadActivity,
): boolean {
  if (candidate.sequence !== undefined && current.sequence !== undefined) {
    if (candidate.sequence !== current.sequence) return candidate.sequence > current.sequence;
  } else if (candidate.sequence !== undefined) {
    return true;
  } else if (current.sequence !== undefined) {
    return false;
  }

  const createdAtComparison = candidate.createdAt.localeCompare(current.createdAt);
  if (createdAtComparison !== 0) return createdAtComparison > 0;
  return candidate.id.localeCompare(current.id) > 0;
}

/**
 * Returns the latest authoritative attachment event for an active provider
 * session. Indicators stay hidden while a session is starting or leaving its
 * active state, when its adapter attachment is not yet current.
 *
 * When a caller has the session creation timestamp, both identity fields are
 * matched. Existing read-model sessions expose providerInstanceId as their
 * stable identity; the event's createdAt remains available for exact matching
 * when the read model exposes that field.
 */
export function latestOptimizerAttachmentForSession(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  currentSession: {
    readonly status: OrchestrationSessionStatus;
    readonly providerInstanceId?: string | null | undefined;
    readonly createdAt?: string | null | undefined;
  } | null,
): OptimizerAttachmentSnapshot | null {
  if (currentSession?.status !== "running" && currentSession?.status !== "ready") return null;
  const providerInstanceId = currentSession?.providerInstanceId;
  const createdAt = currentSession?.createdAt;
  if (providerInstanceId === undefined || providerInstanceId === null) return null;

  let latest: {
    readonly activity: OrchestrationThreadActivity;
    readonly attachment: OptimizerAttachmentSnapshot;
  } | null = null;
  for (const activity of activities) {
    const attachment = optimizerAttachmentFromActivity(activity);
    if (
      attachment === null ||
      attachment.providerInstanceId !== providerInstanceId ||
      (createdAt !== undefined && createdAt !== null && attachment.createdAt !== createdAt)
    )
      continue;
    if (latest === null || isLaterActivity(activity, latest.activity)) {
      latest = { activity, attachment };
    }
  }
  return latest?.attachment ?? null;
}
