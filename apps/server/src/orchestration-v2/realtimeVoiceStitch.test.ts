import type { ProviderAdapterV2RealtimeHistoryEntry } from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, it } from "@effect/vitest";

import {
  REALTIME_VOICE_ORDINAL_STEP,
  realtimeVoiceKey,
  stitchRealtimeVoiceHistory,
} from "./realtimeVoiceStitch.ts";

const speech = (position: number, id: string): ProviderAdapterV2RealtimeHistoryEntry => ({
  type: "realtime",
  position,
  item: { id, realtimeSessionId: "session", type: "transcriptSegment", role: "user", text: id },
});
const turn = (
  type: "turnStarted" | "turnCompleted",
  position: number,
  nativeTurnId: string,
): ProviderAdapterV2RealtimeHistoryEntry =>
  type === "turnStarted"
    ? { type, position, nativeTurnId }
    : { type, position, nativeTurnId, status: "completed" };
const key = (id: string) => realtimeVoiceKey("session", id);

it("places speech between the coding turns it was spoken between", () => {
  const placements = stitchRealtimeVoiceHistory({
    entries: [
      speech(1, "opening"),
      turn("turnStarted", 2, "t1"),
      turn("turnCompleted", 3, "t1"),
      speech(4, "between"),
      turn("turnStarted", 5, "t2"),
      speech(6, "during"),
      turn("turnCompleted", 7, "t2"),
      speech(8, "closing"),
    ],
    turnSpans: new Map([
      ["t1", { first: 1_000_001, last: 1_000_004 }],
      ["t2", { first: 2_000_001, last: 2_000_003 }],
    ]),
    codingOrdinals: [1_000_001, 1_000_002, 1_000_004, 2_000_001, 2_000_003],
    occupiedOrdinals: new Set(),
    existingVoice: new Map(),
  });
  const opening = placements.get(key("opening"))!;
  const between = placements.get(key("between"))!;
  const during = placements.get(key("during"))!;
  const closing = placements.get(key("closing"))!;
  assert.isTrue(opening > 0 && opening < 1_000_001);
  assert.isTrue(between > 1_000_004 && between < 2_000_001);
  // Turn-granular: speech during t2 lands after t2's items, before speech spoken later.
  assert.isTrue(during > 2_000_003 && during < closing);
  assert.equal(closing, during + REALTIME_VOICE_ORDINAL_STEP);
});

it("fills a gap between live receipts in native order", () => {
  const placements = stitchRealtimeVoiceHistory({
    entries: [
      turn("turnCompleted", 1, "t1"),
      speech(2, "received-a"),
      speech(3, "missed-1"),
      speech(4, "missed-2"),
      speech(5, "received-b"),
    ],
    turnSpans: new Map([["t1", { first: 1_000_001, last: 1_000_002 }]]),
    codingOrdinals: [1_000_001, 1_000_002],
    occupiedOrdinals: new Set(),
    existingVoice: new Map([
      [key("received-a"), 1_000_066],
      [key("received-b"), 1_000_130],
    ]),
  });
  const first = placements.get(key("missed-1"))!;
  const second = placements.get(key("missed-2"))!;
  assert.isTrue(1_000_066 < first && first < second && second < 1_000_130);
  assert.isFalse(placements.has(key("received-a")));
});

it("keeps receipt order when no slot or anchor exists", () => {
  const dense = stitchRealtimeVoiceHistory({
    entries: [turn("turnCompleted", 1, "t1"), speech(2, "a"), speech(3, "missed"), speech(4, "b")],
    turnSpans: new Map([["t1", { first: 1, last: 1 }]]),
    codingOrdinals: [1],
    occupiedOrdinals: new Set(),
    existingVoice: new Map([
      [key("a"), 10],
      [key("b"), 11],
    ]),
  });
  assert.isNull(dense.get(key("missed")));
  const unanchored = stitchRealtimeVoiceHistory({
    entries: [speech(1, "alone"), turn("turnStarted", 2, "unknown-turn")],
    turnSpans: new Map(),
    codingOrdinals: [5],
    occupiedOrdinals: new Set(),
    existingVoice: new Map(),
  });
  assert.isNull(unanchored.get(key("alone")));
});

it("anchors a promoted request before the coding turn it started", () => {
  const promoted: ProviderAdapterV2RealtimeHistoryEntry = {
    type: "realtime",
    position: 3,
    item: {
      id: "promotion",
      realtimeSessionId: "session",
      type: "bemItemPromoted",
      item_id: "user-item",
      turn_id: "t2",
      presentation: { type: "wholeItem" },
    },
  };
  const placements = stitchRealtimeVoiceHistory({
    entries: [
      turn("turnCompleted", 1, "t1"),
      speech(2, "request"),
      promoted,
      turn("turnStarted", 4, "t2"),
      { type: "item", position: 5, nativeTurnId: "t2", nativeItemId: "user-item", itemType: "x" },
    ],
    turnSpans: new Map([
      ["t1", { first: 1_000_001, last: 1_000_003 }],
      ["t2", { first: 2_000_001, last: 2_000_004 }],
    ]),
    codingOrdinals: [1_000_001, 1_000_003, 2_000_001, 2_000_004],
    occupiedOrdinals: new Set(),
    existingVoice: new Map(),
  });
  const request = placements.get(key("request"))!;
  const promotion = placements.get(key("promotion"))!;
  assert.isTrue(1_000_003 < request && request < promotion && promotion < 2_000_001);
});

it("skips ordinals another item already holds", () => {
  const placements = stitchRealtimeVoiceHistory({
    entries: [turn("turnCompleted", 1, "t1"), speech(2, "a"), speech(3, "b")],
    turnSpans: new Map([["t1", { first: 1, last: 1 }]]),
    codingOrdinals: [1, 100],
    existingVoice: new Map(),
    // Another native thread's voice sits where an even split would land.
    occupiedOrdinals: new Set([1, 34, 100]),
  });
  assert.deepEqual([placements.get(key("a")), placements.get(key("b"))], [35, 68]);
});
