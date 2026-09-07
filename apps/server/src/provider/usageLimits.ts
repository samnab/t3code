/**
 * Provider-native subscription usage limits, normalised to the shared
 * `ServerProviderUsageWindow` shape carried by `account.rate-limits.updated`.
 *
 * Claude and Codex normalise inside their own adapters (see
 * `claudeUsageLimits.ts` / `codexUsageLimits.ts`); what remains here is the
 * z.ai quota endpoint that Pi reads for GLM sessions.
 */
import * as DateTime from "effect/DateTime";

import type { ServerProviderUsageWindow } from "@t3tools/contracts";

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const titleCase = (value: string): string =>
  value
    .split(/[_\s-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

/**
 * Human label for a provider window key. Known Claude keys get a hand-written
 * label; anything else (including keys added by a future SDK) falls through to
 * a title-cased form rather than being dropped.
 */
export function usageLimitWindowLabel(id: string): string {
  if (id === "five_hour") return "5-hour";
  if (id === "seven_day") return "Weekly";
  const perModel = /^seven_day_(.+)$/.exec(id);
  if (perModel?.[1]) return `Weekly (${titleCase(perModel[1])})`;
  return titleCase(id);
}

/**
 * `GET https://api.z.ai/api/monitor/usage/quota/limit`. Only hourly
 * `TOKENS_LIMIT` entries (unit 3) carry a percentage worth showing.
 */
export function normalizeZaiQuota(raw: unknown): ReadonlyArray<ServerProviderUsageWindow> {
  if (!raw || typeof raw !== "object") return [];
  const data = (raw as Record<string, unknown>).data;
  const limits = data && typeof data === "object" ? (data as Record<string, unknown>).limits : null;
  if (!Array.isArray(limits)) return [];
  const windows: Array<ServerProviderUsageWindow> = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const limit = entry as Record<string, unknown>;
    if (limit.type !== "TOKENS_LIMIT" || limit.unit !== 3) continue;
    const hours = finite(limit.number);
    const percentage = finite(limit.percentage);
    if (hours === null || percentage === null) continue;
    const nextResetTime = finite(limit.nextResetTime);
    windows.push({
      id: `tokens_${hours}h`,
      kind: "session",
      label: `${hours}-hour`,
      usedPercent: clampPercent(percentage),
      ...(nextResetTime === null
        ? {}
        : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(nextResetTime)) }),
      windowDurationMins: Math.round(hours * 60),
    });
  }
  return windows;
}
