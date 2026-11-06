import { describe, expect, it } from "vite-plus/test";

import { isResetCreditExpiringSoon } from "./providerUsageLimits.ts";

describe("isResetCreditExpiringSoon", () => {
  const now = Date.parse("2026-11-06T12:00:00.000Z");

  it.each([
    [
      "inside the lead window",
      { availableCount: 1, nextExpiresAt: "2026-11-06T12:10:00.000Z" },
      true,
    ],
    [
      "at the lead boundary",
      { availableCount: 1, nextExpiresAt: "2026-11-06T12:30:00.000Z" },
      true,
    ],
    [
      "outside the lead window",
      { availableCount: 1, nextExpiresAt: "2026-11-06T12:31:00.000Z" },
      false,
    ],
    ["already expired", { availableCount: 1, nextExpiresAt: "2026-11-06T11:59:59.999Z" }, false],
    ["no credits banked", { availableCount: 0, nextExpiresAt: "2026-11-06T12:01:00.000Z" }, false],
    ["no expiry reported", { availableCount: 2 }, false],
  ])("%s", (_name, credits, expected) => {
    expect(isResetCreditExpiringSoon(credits, now)).toBe(expected);
  });
});
