import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeRealtimeHistoryPage, MAX_REALTIME_HISTORY_BYTES } from "./CodexRealtimeHistory.ts";

const segment = (position: number, role = "user") => ({
  type: "realtime",
  position,
  item: {
    type: "transcriptSegment",
    id: `segment-${position}`,
    realtimeSessionId: "session",
    role,
    text: "Synthetic transcript",
  },
});

describe("CodexRealtimeHistory", () => {
  it.effect("decodes canonical kinds and reduces ordinary content to nonexecuting anchors", () =>
    Effect.gen(function* () {
      const page = yield* decodeRealtimeHistoryPage(
        {
          data: [
            {
              type: "realtime",
              position: 0,
              item: { type: "realtimeSessionStarted", id: "opening", realtimeSessionId: "session" },
            },
            segment(1),
            segment(2, "assistant"),
            {
              type: "realtime",
              position: 3,
              item: {
                type: "bemItemPromoted",
                id: "promotion",
                realtimeSessionId: "session",
                item_id: "item",
                turn_id: "turn",
                presentation: { type: "inlineVisualization", index: 0 },
              },
            },
            {
              type: "item",
              position: 4,
              turnId: "turn",
              item: {
                id: "item",
                type: "userMessage",
                content: [{ type: "text", text: "Never execute" }],
              },
            },
            { type: "turnStarted", position: 5, turn_id: "turn", started_at: null },
            {
              type: "turnCompleted",
              position: 6,
              turn_id: "turn",
              status: "interrupted",
              error: null,
            },
            {
              type: "realtime",
              position: 7,
              item: {
                type: "realtimeSessionClosed",
                id: "closing",
                realtimeSessionId: "session",
                outcome: "failed",
              },
            },
          ],
          nextCursor: "opaque/?=",
          activeRealtimeSessionAtPageStart: null,
        },
        {},
      );
      assert.lengthOf(page.entries, 8);
      assert.deepEqual(page.entries[4], {
        type: "item",
        position: 4,
        nativeTurnId: "turn",
        nativeItemId: "item",
        itemType: "userMessage",
      });
      assert.equal(page.nextCursor, "opaque/?=");
      assert.isNull(page.activeRealtimeSessionAtPageStart);
      assert.deepEqual(yield* decodeRealtimeHistoryPage({ data: [] }, {}), {
        entries: [],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      });
    }),
  );

  it.effect.each([
    { data: [segment(-1)] },
    { data: [{ ...segment(1), item: { ...segment(1).item, id: " padded " } }] },
    {
      data: [
        {
          type: "item",
          position: 1,
          turnId: "turn",
          item: { type: "transcriptSegment", id: "misclassified" },
        },
      ],
    },
    { data: [segment(Number.MAX_SAFE_INTEGER + 1)] },
    { data: [segment(1.5)] },
    { data: [segment(1, "developer")] },
    { data: [{ ...segment(1), item: { ...segment(1).item, id: " " } }] },
    { data: [{ ...segment(1), item: { ...segment(1).item, type: "unknown" } }] },
    { data: [{ ...segment(1), item: { ...segment(1).item, realtimeSessionId: "" } }] },
    { data: [segment(2), segment(1)] },
    { data: [segment(1), segment(1)] },
    { data: [segment(1), { ...segment(1), position: 2 }] },
    { data: [], activeRealtimeSessionAtPageStart: "" },
    { data: [], nextCursor: 12 },
    {
      data: [
        {
          type: "realtime",
          position: 1,
          item: {
            type: "bemItemPromoted",
            id: "p",
            realtimeSessionId: "s",
            item_id: "i",
            turn_id: "t",
            presentation: { type: "inlineVisualization", index: Number.MAX_SAFE_INTEGER + 1 },
          },
        },
      ],
    },
  ])("rejects malformed or contradictory pages without retaining payload: %#", (value) =>
    Effect.gen(function* () {
      const error = yield* decodeRealtimeHistoryPage(value, {}).pipe(Effect.flip);
      assert.equal(error._tag, "CodexRealtimeHistoryError");
      assert.notProperty(error, "cause");
      assert.notProperty(error, "payload");
      assert.notInclude(JSON.stringify(error), "Synthetic transcript");
    }),
  );

  it.effect("enforces page/request bounds including the original unprojected response", () =>
    Effect.gen(function* () {
      for (const limit of [0, -1, 76, Number.NaN, 1.5]) {
        assert.equal(
          (yield* decodeRealtimeHistoryPage({ data: [] }, { limit }).pipe(Effect.flip)).reason,
          "invalid_request",
        );
      }
      assert.equal(
        (yield* decodeRealtimeHistoryPage({ data: [segment(1), segment(2)] }, { limit: 1 }).pipe(
          Effect.flip,
        )).reason,
        "oversized_page",
      );
      assert.equal(
        (yield* decodeRealtimeHistoryPage(
          { data: [], nextCursor: "opaque" },
          { cursor: "opaque" },
        ).pipe(Effect.flip)).reason,
        "inconsistent_page",
      );
      assert.equal(
        (yield* decodeRealtimeHistoryPage(
          { data: [], unknownLargeField: "x".repeat(MAX_REALTIME_HISTORY_BYTES) },
          {},
        ).pipe(Effect.flip)).reason,
        "oversized_page",
      );
    }),
  );
});
