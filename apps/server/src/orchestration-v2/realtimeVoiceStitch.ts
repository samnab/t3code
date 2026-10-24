import type { ProviderAdapterV2RealtimeHistoryEntry } from "@t3tools/provider-core/server/ProviderAdapter";

/** Room left after each live voice receipt so recovered speech can land between received items. */
// ponytail: fixed gap, recovered runs longer than 63 items between two live receipts stay unreconciled.
export const REALTIME_VOICE_ORDINAL_STEP = 64;

/** Native identity of one canonical realtime item. Session IDs are reusable, so both parts count. */
export const realtimeVoiceKey = (realtimeSessionId: string, itemId: string) =>
  `${realtimeSessionId.length}:${realtimeSessionId}${itemId}`;

interface RealtimeVoiceStitchInput {
  /** Provider history in native position order. */
  readonly entries: ReadonlyArray<ProviderAdapterV2RealtimeHistoryEntry>;
  /** Projected ordinal span of each native coding turn that T3 recorded. */
  readonly turnSpans: ReadonlyMap<string, { readonly first: number; readonly last: number }>;
  /** Ordinals of every projected item that is not realtime voice. */
  readonly codingOrdinals: ReadonlyArray<number>;
  /** Ordinals of voice items already projected, by `realtimeVoiceKey`. */
  readonly existingVoice: ReadonlyMap<string, number>;
}

/**
 * Places missing realtime items after the coding turn that preceded them natively, or before the
 * first coding turn when speech opened the thread. Placement is turn-granular: speech during a turn
 * lands after that turn's items. Returns an ordinal per missing key, or null when no honest slot
 * exists and the item must keep receipt order.
 */
export function stitchRealtimeVoiceHistory(
  input: RealtimeVoiceStitchInput,
): ReadonlyMap<string, number | null> {
  const coding = [...input.codingOrdinals].sort((left, right) => left - right);
  const nextCodingAfter = (ordinal: number) =>
    coding.find((candidate) => candidate > ordinal) ?? Number.POSITIVE_INFINITY;
  const lastCodingBefore = (ordinal: number) =>
    coding.findLast((candidate) => candidate < ordinal) ?? -1;

  const gaps = new Map<number, Array<string>>();
  const addToGap = (lower: number, keys: ReadonlyArray<string>) => {
    const gap = gaps.get(lower);
    if (gap === undefined) gaps.set(lower, [...keys]);
    else gap.push(...keys);
  };
  const placements = new Map<string, number | null>();
  let anchor: number | undefined;
  let opening: Array<string> = [];
  for (const entry of input.entries) {
    if (entry.type === "realtime") {
      const key = realtimeVoiceKey(entry.item.realtimeSessionId, entry.item.id);
      if (anchor === undefined) opening.push(key);
      else addToGap(anchor, [key]);
      continue;
    }
    const span = input.turnSpans.get(entry.nativeTurnId);
    if (span === undefined) continue;
    if (opening.length > 0) {
      addToGap(lastCodingBefore(span.first), opening);
      opening = [];
    }
    anchor = Math.max(anchor ?? -1, span.last);
  }
  // No recorded coding turn anywhere in the read: there is nothing to anchor against.
  for (const key of opening) placements.set(key, null);

  const place = (keys: ReadonlyArray<string>, lower: number, upper: number) => {
    if (keys.length === 0) return;
    const step =
      upper === Number.POSITIVE_INFINITY
        ? REALTIME_VOICE_ORDINAL_STEP
        : Math.floor((upper - lower) / (keys.length + 1));
    keys.forEach((key, index) => placements.set(key, step < 1 ? null : lower + step * (index + 1)));
  };
  for (const [lower, keys] of gaps) {
    const upper = nextCodingAfter(lower);
    let previous = Math.max(lower, 0);
    let missing: Array<string> = [];
    for (const key of keys) {
      const existing = input.existingVoice.get(key);
      if (existing === undefined) {
        missing.push(key);
        continue;
      }
      // A received neighbor outside this gap, or out of native order, is not a usable bound.
      if (existing <= previous || existing >= upper) continue;
      place(missing, previous, existing);
      previous = existing;
      missing = [];
    }
    place(missing, previous, upper);
  }
  return placements;
}
