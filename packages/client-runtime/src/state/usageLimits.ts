import type { OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * One usage window as carried by a `usage-limits.updated` thread activity.
 * Local to this fold: the published provider snapshot uses
 * `ServerProviderUsageWindow` (ISO reset time), while the activity payload
 * stays on epoch milliseconds.
 */
export type UsageLimitWindow = {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
};

export type ProviderUsageLimits = {
  readonly provider: string;
  readonly windows: ReadonlyArray<UsageLimitWindow>;
  readonly updatedAt: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readWindows(value: unknown): ReadonlyArray<UsageLimitWindow> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ReadonlyArray<UsageLimitWindow> => {
    const window = asRecord(entry);
    if (!window) return [];
    const { id, label, usedPercent, resetsAt } = window;
    if (typeof id !== "string" || id.length === 0) return [];
    if (typeof label !== "string" || typeof usedPercent !== "number") return [];
    if (!Number.isFinite(usedPercent)) return [];
    return [
      {
        id,
        label,
        usedPercent,
        resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : null,
      },
    ];
  });
}

/**
 * Fold `usage-limits.updated` activities into the latest known windows per
 * provider. `replace` snapshots (Codex, z.ai) drop prior windows; incremental
 * updates (Claude, one window per SDK event) merge by window id.
 *
 * Activities from every provider seen in the given list contribute, so a
 * thread's meter can show limits for providers other than its own.
 */
export function mergeUsageLimitActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  seed: ReadonlyArray<ProviderUsageLimits> = [],
): ReadonlyArray<ProviderUsageLimits> {
  const byProvider = new Map<string, ProviderUsageLimits>(
    seed.map((entry) => [entry.provider, entry]),
  );

  for (const activity of activities) {
    if (activity.kind !== "usage-limits.updated") continue;
    const payload = asRecord(activity.payload);
    const provider = payload?.provider;
    if (typeof provider !== "string" || provider.length === 0) continue;
    const windows = readWindows(payload?.windows);
    if (windows.length === 0) continue;

    const previous = payload?.replace === true ? [] : (byProvider.get(provider)?.windows ?? []);
    const merged = new Map(previous.map((window) => [window.id, window]));
    for (const window of windows) merged.set(window.id, window);
    byProvider.set(provider, {
      provider,
      windows: [...merged.values()],
      updatedAt: activity.createdAt,
    });
  }

  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** `"2h 10m"`, `"45m"`, `"30s"`, or null once the window has already reset. */
export function formatUsageLimitReset(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return null;
  const seconds = Math.round((resetsAt - now) / 1000);
  if (seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
  }
  if (hours > 0) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
