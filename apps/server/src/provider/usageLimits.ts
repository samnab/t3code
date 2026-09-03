/**
 * Provider-native subscription usage limits, normalised to the shared
 * `UsageLimitWindow` shape carried by `account.rate-limits.updated`.
 *
 * Each adapter calls its own normaliser at the boundary so orchestration and
 * the clients never learn a provider-native rate-limit shape.
 */
import type { UsageLimitWindow } from "@t3tools/contracts";

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

/** Codex windows are minute-durations, so the label is derived from the span. */
function codexWindowLabel(windowDurationMins: number | null, fallback: string): string {
  if (windowDurationMins === null || windowDurationMins <= 0) return fallback;
  if (windowDurationMins % (60 * 24) === 0) {
    const days = windowDurationMins / (60 * 24);
    return days === 7 ? "Weekly" : days === 1 ? "Daily" : `${days}-day`;
  }
  if (windowDurationMins % 60 === 0) return `${windowDurationMins / 60}-hour`;
  return `${windowDurationMins}-minute`;
}

/**
 * `account/rateLimits/{updated,read}` from the Codex app server. Reset times
 * are unix seconds; a snapshot always describes every window Codex knows.
 */
export function normalizeCodexRateLimits(raw: unknown): ReadonlyArray<UsageLimitWindow> {
  if (!raw || typeof raw !== "object") return [];
  const snapshot = raw as Record<string, unknown>;
  const windows: Array<UsageLimitWindow> = [];
  for (const key of ["primary", "secondary"] as const) {
    const value = snapshot[key];
    if (!value || typeof value !== "object") continue;
    const window = value as Record<string, unknown>;
    const usedPercent = finite(window.usedPercent);
    if (usedPercent === null) continue;
    const resetsAtSeconds = finite(window.resetsAt);
    windows.push({
      id: key,
      label: codexWindowLabel(finite(window.windowDurationMins), titleCase(key)),
      usedPercent: clampPercent(usedPercent),
      resetsAt: resetsAtSeconds === null ? null : resetsAtSeconds * 1000,
    });
  }
  return windows;
}

/**
 * One `rate_limit_event` from the Claude Agent SDK. It carries a single
 * window, so the result is merged by id rather than replacing prior state.
 */
export function normalizeClaudeRateLimit(raw: unknown): ReadonlyArray<UsageLimitWindow> {
  if (!raw || typeof raw !== "object") return [];
  const info = raw as Record<string, unknown>;
  const id = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
  const utilization = finite(info.utilization);
  if (id === null || id.length === 0 || utilization === null) return [];
  const resetsAtSeconds = finite(info.resetsAt);
  return [
    {
      id,
      label: usageLimitWindowLabel(id),
      usedPercent: clampPercent(utilization),
      resetsAt: resetsAtSeconds === null ? null : resetsAtSeconds * 1000,
    },
  ];
}

/**
 * `GET https://api.z.ai/api/monitor/usage/quota/limit`. Only hourly
 * `TOKENS_LIMIT` entries (unit 3) carry a percentage worth showing.
 */
export function normalizeZaiQuota(raw: unknown): ReadonlyArray<UsageLimitWindow> {
  if (!raw || typeof raw !== "object") return [];
  const data = (raw as Record<string, unknown>).data;
  const limits = data && typeof data === "object" ? (data as Record<string, unknown>).limits : null;
  if (!Array.isArray(limits)) return [];
  const windows: Array<UsageLimitWindow> = [];
  for (const entry of limits) {
    if (!entry || typeof entry !== "object") continue;
    const limit = entry as Record<string, unknown>;
    if (limit.type !== "TOKENS_LIMIT" || limit.unit !== 3) continue;
    const hours = finite(limit.number);
    const percentage = finite(limit.percentage);
    if (hours === null || percentage === null) continue;
    windows.push({
      id: `tokens_${hours}h`,
      label: `${hours}-hour`,
      usedPercent: clampPercent(percentage),
      resetsAt: finite(limit.nextResetTime),
    });
  }
  return windows;
}
