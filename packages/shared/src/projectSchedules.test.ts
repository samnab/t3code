// @effect-diagnostics globalDate:off -- Schedule math is pure wall-clock arithmetic over Intl and JS Date.
import { describe, expect, it } from "@effect/vitest";
import type { ProjectScheduleCadence } from "@t3tools/contracts";

import { nextFireAfter } from "./projectSchedules.ts";

const utc = (iso: string): Date => new Date(iso);

describe("nextFireAfter", () => {
  it("rolls hourly to the next hour when the minute already passed", () => {
    const cadence: ProjectScheduleCadence = { kind: "hourly", minute: 45 };
    expect(nextFireAfter(cadence, "UTC", utc("2026-01-15T10:46:00.000Z")).toISOString()).toBe(
      "2026-01-15T11:45:00.000Z",
    );
    expect(nextFireAfter(cadence, "UTC", utc("2026-01-15T10:20:30.000Z")).toISOString()).toBe(
      "2026-01-15T10:45:00.000Z",
    );
  });

  it("rolls daily across midnight", () => {
    const cadence: ProjectScheduleCadence = { kind: "daily", time: "08:00" };
    expect(nextFireAfter(cadence, "UTC", utc("2026-01-15T23:30:00.000Z")).toISOString()).toBe(
      "2026-01-16T08:00:00.000Z",
    );
  });

  it("picks the next listed weekday for weekly", () => {
    const cadence: ProjectScheduleCadence = { kind: "weekly", weekdays: [1, 3], time: "09:00" };
    // 2026-01-15 is a Thursday, so the next Monday is 2026-01-19.
    expect(nextFireAfter(cadence, "UTC", utc("2026-01-15T12:00:00.000Z")).toISOString()).toBe(
      "2026-01-19T09:00:00.000Z",
    );
  });

  it("fires at the right UTC instant in a non-UTC zone", () => {
    const cadence: ProjectScheduleCadence = { kind: "daily", time: "09:00" };
    // Toronto is UTC-5 in January.
    expect(nextFireAfter(cadence, "America/Toronto", utc("2026-01-15T00:00:00.000Z")).toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
  });

  it("never returns the after instant itself", () => {
    const cadence: ProjectScheduleCadence = { kind: "daily", time: "08:00" };
    expect(nextFireAfter(cadence, "UTC", utc("2026-01-15T08:00:00.000Z")).toISOString()).toBe(
      "2026-01-16T08:00:00.000Z",
    );
  });
  it("throws RangeError for an invalid timeZone", () => {
    const cadence: ProjectScheduleCadence = { kind: "daily", time: "08:00" };
    expect(() => nextFireAfter(cadence, "Mars/Olympus", new Date())).toThrow(RangeError);
  });
});
