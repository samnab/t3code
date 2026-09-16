// @effect-diagnostics globalDate:off -- Schedule math is pure wall-clock arithmetic over Intl and JS Date.
import type { ProjectScheduleCadence } from "@t3tools/contracts";

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function readWallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type);
    if (part === undefined) throw new RangeError("Unexpected clock fields for " + type);
    return Number(part.value);
  };
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
  };
}

// UTC offset at an instant, derived from the wall clock of the zone itself,
// so DST shifts need no offset table. An invalid timeZone throws RangeError here.
function offsetMs(instant: Date, timeZone: string): number {
  const wall = readWallClock(instant, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - instant.getTime();
}

// Instant for a wall-clock time, with a second pass to absorb DST shifts
// between the assumed and actual offsets.
function resolveWallClock(wall: WallClock, timeZone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let instant = asUtc - offsetMs(new Date(asUtc), timeZone);
  const corrected = asUtc - offsetMs(new Date(instant), timeZone);
  if (corrected !== instant) instant = corrected;
  return new Date(instant);
}

/**
 * Next instant strictly after `after` at which `cadence` fires in `timeZone`.
 * Pure, uses Intl only. Throws RangeError for an invalid timeZone.
 */
export function nextFireAfter(
  cadence: ProjectScheduleCadence,
  timeZone: string,
  after: Date,
): Date {
  const local = readWallClock(after, timeZone);
  const afterMs = after.getTime();

  if (cadence.kind === "hourly") {
    let candidate = resolveWallClock({ ...local, minute: cadence.minute }, timeZone);
    while (candidate.getTime() <= afterMs) {
      const wall = readWallClock(candidate, timeZone);
      candidate = resolveWallClock({ ...wall, hour: wall.hour + 1, minute: cadence.minute }, timeZone);
    }
    return candidate;
  }

  const hour = Number(cadence.time.slice(0, 2));
  const minute = Number(cadence.time.slice(3, 5));

  if (cadence.kind === "daily") {
    let candidate = resolveWallClock({ ...local, hour, minute }, timeZone);
    while (candidate.getTime() <= afterMs) {
      const wall = readWallClock(candidate, timeZone);
      candidate = resolveWallClock({ ...wall, day: wall.day + 1, hour, minute }, timeZone);
    }
    return candidate;
  }

  // Weekly: first matching weekday whose fire time is still ahead, searching
  // the next 7 calendar days from the local today.
  const today = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay();
  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    const weekday = (today + dayOffset) % 7;
    if (!cadence.weekdays.some((entry) => entry === weekday)) continue;
    const candidate = resolveWallClock({ ...local, day: local.day + dayOffset, hour, minute }, timeZone);
    if (candidate.getTime() > afterMs) return candidate;
  }
  return resolveWallClock({ ...local, day: local.day + 7, hour, minute }, timeZone);
}
