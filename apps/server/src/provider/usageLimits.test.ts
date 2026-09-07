import { describe, expect, it } from "vite-plus/test";
import { normalizeZaiQuota, usageLimitWindowLabel } from "./usageLimits.ts";

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
    ).toEqual([
      {
        id: "tokens_5h",
        kind: "session",
        label: "5-hour",
        usedPercent: 12,
        resetsAt: "2023-11-14T22:13:20.000Z",
        windowDurationMins: 300,
      },
    ]);
  });

  it("returns nothing for malformed payloads", () => {
    expect(normalizeZaiQuota({ data: {} })).toEqual([]);
    expect(normalizeZaiQuota(null)).toEqual([]);
  });
});
