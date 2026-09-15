import type { DelegationCandidate, ServerProviderUsageLimits } from "@t3tools/contracts";

/**
 * Pure delegation-tier resolution for `subagent_spawn` with a `tier`. The
 * caller (ChildRunService) gathers per-instance availability and usage
 * snapshots effectfully, then uses these helpers to pick the first eligible
 * candidate. T3 only skips on facts it has: unknown usage headroom never
 * blocks a candidate.
 */

/** Claude reports per-model weekly windows as `seven_day_<model>`; all other window ids are account-wide. */
const SEVEN_DAY_PER_MODEL = /^seven_day_(.+)$/;

export interface DelegationCandidateAvailability {
  readonly instanceAvailable: boolean;
  readonly reason?: string;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
}

export interface DelegationCandidateEvaluation {
  readonly eligible: boolean;
  readonly headroomPercent?: number;
  readonly reason?: string;
}

/**
 * Remaining usage headroom as `100 - max(usedPercent)` over the windows that
 * apply to the candidate's model. Per-model `seven_day_*` windows count only
 * when the model name contains the window's model suffix; every other window
 * always counts. Unknown when there is no snapshot, the provider cannot
 * report usage (`unavailable`), or no window applies.
 */
export const candidateHeadroomPercent = (
  candidate: Pick<DelegationCandidate, "model">,
  usageLimits: ServerProviderUsageLimits | undefined,
): number | undefined => {
  if (usageLimits === undefined || usageLimits.unavailable !== undefined) return undefined;
  let maxUsedPercent: number | undefined;
  for (const window of usageLimits.windows) {
    const perModel = window.id.match(SEVEN_DAY_PER_MODEL)?.[1];
    if (perModel !== undefined && !candidate.model.toLowerCase().includes(perModel.toLowerCase())) {
      continue;
    }
    maxUsedPercent =
      maxUsedPercent === undefined || window.usedPercent > maxUsedPercent
        ? window.usedPercent
        : maxUsedPercent;
  }
  return maxUsedPercent === undefined ? undefined : 100 - maxUsedPercent;
};

export const evaluateCandidate = (
  candidate: DelegationCandidate,
  availability: DelegationCandidateAvailability,
): DelegationCandidateEvaluation => {
  if (!availability.instanceAvailable) {
    return {
      eligible: false,
      ...(availability.reason === undefined ? {} : { reason: availability.reason }),
    };
  }
  const headroomPercent = candidateHeadroomPercent(candidate, availability.usageLimits);
  if (
    candidate.minHeadroomPercent !== undefined &&
    headroomPercent !== undefined &&
    headroomPercent < candidate.minHeadroomPercent
  ) {
    return {
      eligible: false,
      headroomPercent,
      reason: `usage headroom ${headroomPercent}% is below the required ${candidate.minHeadroomPercent}%`,
    };
  }
  return {
    eligible: true,
    ...(headroomPercent === undefined ? {} : { headroomPercent }),
  };
};

/** The first candidate whose evaluation is eligible, in the tier's configured order. */
export const resolveTier = <T>(
  candidates: ReadonlyArray<T>,
  evaluate: (candidate: T) => DelegationCandidateEvaluation,
): T | undefined => {
  for (const candidate of candidates) {
    if (evaluate(candidate).eligible) return candidate;
  }
  return undefined;
};
