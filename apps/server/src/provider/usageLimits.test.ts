import { describe, expect, it } from "vite-plus/test";
import {
  normalizeClaudeRateLimit,
  normalizeCodexRateLimits,
  normalizeZaiQuota,
  usageLimitWindowLabel,
} from "./usageLimits.ts";

describe("normalizeCodexRateLimits", () => {
  it("normalizes both windows and converts reset seconds to milliseconds", () => {
    expect(
      normalizeCodexRateLimits({
        primary: { usedPercent: 42, resetsAt: 1_700_000_000, windowDurationMins: 300 },
        secondary: { usedPercent: 7, resetsAt: null, windowDurationMins: 10_080 },
      }),
    ).toEqual([
      { id: "primary", label: "5-hour", usedPercent: 42, resetsAt: 1_700_000_000_000 },
      { id: "secondary", label: "Weekly", usedPercent: 7, resetsAt: null },
    ]);
  });

  it("drops windows without a usable percentage", () => {
    expect(normalizeCodexRateLimits({ primary: null, secondary: {} })).toEqual([]);
    expect(normalizeCodexRateLimits(undefined)).toEqual([]);
  });
});

describe("normalizeClaudeRateLimit", () => {
  it("emits the single window the SDK event carries", () => {
    expect(
      normalizeClaudeRateLimit({
        status: "allowed",
        rateLimitType: "seven_day_opus",
        utilization: 63.5,
        resetsAt: 1_700_000_000,
      }),
    ).toEqual([
      {
        id: "seven_day_opus",
        label: "Weekly (Opus)",
        usedPercent: 63.5,
        resetsAt: 1_700_000_000_000,
      },
    ]);
  });

  it("ignores events without a type or utilization", () => {
    expect(normalizeClaudeRateLimit({ status: "allowed" })).toEqual([]);
  });
});

describe("usageLimitWindowLabel", () => {
  it("title-cases unknown keys instead of dropping them", () => {
    expect(usageLimitWindowLabel("five_hour")).toBe("5-hour");
    expect(usageLimitWindowLabel("seven_day")).toBe("Weekly");
    expect(usageLimitWindowLabel("seven_day_fable")).toBe("Weekly (Fable)");
    expect(usageLimitWindowLabel("overage")).toBe("Overage");
    expect(usageLimitWindowLabel("monthly_extra_credits")).toBe("Monthly Extra Credits");
  });
});

describe("normalizeZaiQuota", () => {
  it("keeps only hourly token windows", () => {
    expect(
      normalizeZaiQuota({
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 12,
              nextResetTime: 1_700_000_000_000,
            },
            { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 90 },
          ],
        },
      }),
    ).toEqual([{ id: "tokens_5h", label: "5-hour", usedPercent: 12, resetsAt: 1_700_000_000_000 }]);
  });

  it("returns nothing for malformed payloads", () => {
    expect(normalizeZaiQuota({ data: {} })).toEqual([]);
    expect(normalizeZaiQuota(null)).toEqual([]);
  });
});
