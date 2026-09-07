// @effect-diagnostics globalDate:off -- Throughput display uses wall-clock turn timestamps.
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface TurnOutputUsage {
  readonly outputTokens: number;
  readonly source: "turn.usage";
}

export interface TurnOutputTiming {
  readonly turnId: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface SubagentOutputTiming {
  readonly outputTokens: number | undefined;
  readonly durationMs: number | undefined;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly activationCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseDuration(
  startedAt: string | null,
  completedAt: string | null,
  nowMs: number,
): number | null {
  if (startedAt === null) return null;
  const startedMs = Date.parse(startedAt);
  const endedMs = completedAt === null ? nowMs : Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return null;
  return Math.max(0, endedMs - startedMs);
}

/** Terminal usage is the only trustworthy whole-turn output total. Context
 * snapshots are per-request and may undercount turns with multiple model
 * calls, so the rate stays unavailable until this activity is persisted. */
export function deriveTurnOutputUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: string,
): TurnOutputUsage | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.turnId !== turnId || activity.kind !== "turn.usage") continue;
    const payload = asRecord(activity.payload);
    const outputTokens = asNonNegativeNumber(payload?.outputTokens);
    if (outputTokens !== null) {
      return { outputTokens, source: "turn.usage" };
    }
  }

  return null;
}

export function deriveAverageOutputTokensPerSecond(
  outputTokens: number | undefined,
  startedAt: string | null,
  completedAt: string | null,
  nowMs = Date.now(),
  durationMs?: number,
): number | null {
  const output = asNonNegativeNumber(outputTokens);
  if (output === null) return null;
  // Lifecycle timestamps cover tools, waiting, and provider gaps. A provider
  // duration is only a fallback for retained rows that lack both endpoints.
  const duration = parseDuration(startedAt, completedAt, nowMs) ?? durationMs ?? null;
  if (duration === null || duration <= 0) return null;
  return output / (duration / 1_000);
}

export function deriveTurnAverageOutputTokensPerSecond(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turn: TurnOutputTiming,
  nowMs = Date.now(),
): number | null {
  const usage = deriveTurnOutputUsage(activities, turn.turnId);
  return deriveAverageOutputTokensPerSecond(
    usage?.outputTokens,
    turn.startedAt,
    turn.completedAt,
    nowMs,
  );
}

/**
 * Resumed children have cumulative usage but no durable activation timeline.
 * Omitting their rate is safer than dividing lifetime output by one activation.
 */
export function deriveSubagentAverageOutputTokensPerSecond(
  timing: SubagentOutputTiming,
  nowMs = Date.now(),
): number | null {
  if (timing.activationCount !== 1) return null;
  return deriveAverageOutputTokensPerSecond(
    timing.outputTokens,
    timing.startedAt,
    timing.completedAt,
    nowMs,
    timing.durationMs,
  );
}

export function formatAverageOutputTokensPerSecond(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate) || rate < 0) return null;
  const value = rate < 100 ? rate.toFixed(1).replace(/\.0$/, "") : Math.round(rate).toString();
  return `${value} tok/s avg`;
}
