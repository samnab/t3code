import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatUsageLimitReset, mergeUsageLimitActivities } from "./usageLimits.ts";

const activity = (
  id: string,
  payload: unknown,
  kind = "usage-limits.updated",
): OrchestrationThreadActivity =>
  ({
    id,
    createdAt: "2026-08-06T00:00:00.000Z",
    tone: "info",
    kind,
    summary: "Usage limits updated",
    payload,
    turnId: null,
  }) as unknown as OrchestrationThreadActivity;

describe("mergeUsageLimitActivities", () => {
  it("merges single-window Claude updates by id and keeps providers apart", () => {
    const result = mergeUsageLimitActivities([
      activity("a", {
        provider: "claude",
        replace: false,
        windows: [{ id: "five_hour", label: "5-hour", usedPercent: 10, resetsAt: 1 }],
      }),
      activity("b", {
        provider: "claude",
        replace: false,
        windows: [{ id: "seven_day", label: "Weekly", usedPercent: 20, resetsAt: 2 }],
      }),
      activity("c", {
        provider: "claude",
        replace: false,
        windows: [{ id: "five_hour", label: "5-hour", usedPercent: 30, resetsAt: 3 }],
      }),
      activity("d", {
        provider: "codex",
        replace: true,
        windows: [{ id: "primary", label: "5-hour", usedPercent: 5, resetsAt: null }],
      }),
    ]);

    expect(result).toEqual([
      {
        provider: "claude",
        updatedAt: "2026-08-06T00:00:00.000Z",
        windows: [
          { id: "five_hour", label: "5-hour", usedPercent: 30, resetsAt: 3 },
          { id: "seven_day", label: "Weekly", usedPercent: 20, resetsAt: 2 },
        ],
      },
      {
        provider: "codex",
        updatedAt: "2026-08-06T00:00:00.000Z",
        windows: [{ id: "primary", label: "5-hour", usedPercent: 5, resetsAt: null }],
      },
    ]);
  });

  it("replaces prior windows on a full snapshot", () => {
    const result = mergeUsageLimitActivities([
      activity("a", {
        provider: "codex",
        replace: true,
        windows: [
          { id: "primary", label: "5-hour", usedPercent: 5, resetsAt: null },
          { id: "secondary", label: "Weekly", usedPercent: 8, resetsAt: null },
        ],
      }),
      activity("b", {
        provider: "codex",
        replace: true,
        windows: [{ id: "primary", label: "5-hour", usedPercent: 9, resetsAt: null }],
      }),
    ]);

    expect(result[0]?.windows).toEqual([
      { id: "primary", label: "5-hour", usedPercent: 9, resetsAt: null },
    ]);
  });

  it("ignores other activity kinds and malformed payloads", () => {
    expect(mergeUsageLimitActivities([activity("a", {}, "context-window.updated")])).toEqual([]);
    expect(mergeUsageLimitActivities([activity("b", { provider: "codex" })])).toEqual([]);
    expect(
      mergeUsageLimitActivities([
        activity("c", { provider: "codex", replace: true, windows: [{ id: "x" }] }),
      ]),
    ).toEqual([]);
  });
});

describe("formatUsageLimitReset", () => {
  const now = 1_000_000_000_000;
  it("renders coarse relative durations", () => {
    expect(formatUsageLimitReset(now + 2 * 3_600_000 + 10 * 60_000, now)).toBe("2h 10m");
    expect(formatUsageLimitReset(now + 45 * 60_000, now)).toBe("45m");
    expect(formatUsageLimitReset(now + 30_000, now)).toBe("30s");
    expect(formatUsageLimitReset(now + 3 * 86_400_000, now)).toBe("3d");
  });

  it("returns null once the window has reset or has no reset time", () => {
    expect(formatUsageLimitReset(now - 1, now)).toBeNull();
    expect(formatUsageLimitReset(null, now)).toBeNull();
  });
});
