import type { ProviderAdapterV2RealtimeHistoryEntry } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MAX_REALTIME_HISTORY_ITEMS = 75;
export const MAX_REALTIME_HISTORY_BYTES = 1_048_576;

export class CodexRealtimeHistoryError extends Schema.TaggedError<CodexRealtimeHistoryError>()(
  "CodexRealtimeHistoryError",
  {
    reason: Schema.Literals([
      "invalid_request",
      "invalid_page",
      "oversized_page",
      "inconsistent_page",
    ]),
  },
) {}

// Preserve opaque source identity; never trim it into a different canonical key.
const SourceId = Schema.NonEmptyString.check(Schema.isTrimmed());
const RealtimeKinds = new Set([
  "realtimeSessionStarted",
  "transcriptSegment",
  "bemItemPromoted",
  "realtimeSessionClosed",
]);
const Identity = { id: SourceId, realtimeSessionId: SourceId };
const RealtimeItem = Schema.Union([
  Schema.Struct({ ...Identity, type: Schema.Literal("realtimeSessionStarted") }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("transcriptSegment"),
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String,
  }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("bemItemPromoted"),
    item_id: SourceId,
    turn_id: SourceId,
    presentation: Schema.Union([
      Schema.Struct({ type: Schema.Literal("wholeItem") }),
      Schema.Struct({ type: Schema.Literal("inlineMarkdown") }),
      Schema.Struct({ type: Schema.Literal("inlineVisualization"), index: Schema.Natural }),
    ]),
  }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("realtimeSessionClosed"),
    outcome: Schema.Literals(["ended", "failed"]),
  }),
]);
const Position = { position: Schema.Natural };
const Entry = Schema.Union([
  Schema.Struct({ ...Position, type: Schema.Literal("realtime"), item: RealtimeItem }),
  Schema.Struct({
    ...Position,
    type: Schema.Literal("item"),
    turnId: SourceId,
    item: Schema.Struct({ id: SourceId, type: SourceId }),
  }),
  Schema.Struct({
    ...Position,
    type: Schema.Literal("turnStarted"),
    turn_id: SourceId,
  }),
  Schema.Struct({
    ...Position,
    type: Schema.Literal("turnCompleted"),
    turn_id: SourceId,
    status: Schema.Literals(["inProgress", "completed", "interrupted", "failed"]),
  }),
]);
const Page = Schema.Struct({
  data: Schema.Array(Entry),
  activeRealtimeSessionAtPageStart: Schema.optionalKey(Schema.NullOr(SourceId)),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodePage = Schema.decodeUnknownEffect(Page);
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export function isValidRealtimeHistoryRequest(input: {
  readonly limit?: number;
  readonly cursor?: string | null;
}) {
  const limit = input.limit ?? MAX_REALTIME_HISTORY_ITEMS;
  return (
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit <= MAX_REALTIME_HISTORY_ITEMS &&
    (input.cursor == null ||
      (typeof input.cursor === "string" &&
        Buffer.byteLength(input.cursor, "utf8") <= MAX_REALTIME_HISTORY_BYTES))
  );
}

/** Decode one native page. Ordinary items are reduced to anchors; no executable payload escapes. */
export const decodeRealtimeHistoryPage = Effect.fn("CodexRealtimeHistory.decodePage")(function* (
  value: unknown,
  request: { readonly limit?: number; readonly cursor?: string | null },
) {
  if (!isValidRealtimeHistoryRequest(request))
    return yield* new CodexRealtimeHistoryError({ reason: "invalid_request" });
  // The transport has already allocated the response. This bounds decoded work, not raw frame allocation.
  const encoded = yield* encodeUnknownJson(value).pipe(
    Effect.mapError(() => new CodexRealtimeHistoryError({ reason: "invalid_page" })),
  );
  if (Buffer.byteLength(encoded, "utf8") > MAX_REALTIME_HISTORY_BYTES)
    return yield* new CodexRealtimeHistoryError({ reason: "oversized_page" });
  const page = yield* decodePage(value).pipe(
    Effect.mapError(() => new CodexRealtimeHistoryError({ reason: "invalid_page" })),
  );
  if (page.data.length > (request.limit ?? MAX_REALTIME_HISTORY_ITEMS))
    return yield* new CodexRealtimeHistoryError({ reason: "oversized_page" });
  if (request.cursor != null && page.nextCursor === request.cursor)
    return yield* new CodexRealtimeHistoryError({ reason: "inconsistent_page" });
  const identities = new Set<string>();
  let previous = -1;
  const entries: Array<ProviderAdapterV2RealtimeHistoryEntry> = [];
  for (const entry of page.data) {
    if (entry.position <= previous)
      return yield* new CodexRealtimeHistoryError({ reason: "inconsistent_page" });
    previous = entry.position;
    const identityParts =
      entry.type === "realtime"
        ? ["realtime", entry.item.realtimeSessionId, entry.item.id]
        : entry.type === "item"
          ? ["item", entry.turnId, entry.item.id]
          : [entry.type, entry.turn_id];
    const identity = identityParts.map((part) => `${part.length}:${part}`).join("");
    if (identities.has(identity))
      return yield* new CodexRealtimeHistoryError({ reason: "inconsistent_page" });
    identities.add(identity);
    switch (entry.type) {
      case "realtime":
        entries.push(entry);
        break;
      case "item":
        if (RealtimeKinds.has(entry.item.type))
          return yield* new CodexRealtimeHistoryError({ reason: "inconsistent_page" });
        entries.push({
          type: "item",
          position: entry.position,
          nativeTurnId: entry.turnId,
          nativeItemId: entry.item.id,
          itemType: entry.item.type,
        });
        break;
      case "turnStarted":
        entries.push({
          type: "turnStarted",
          position: entry.position,
          nativeTurnId: entry.turn_id,
        });
        break;
      case "turnCompleted":
        entries.push({
          type: "turnCompleted",
          position: entry.position,
          nativeTurnId: entry.turn_id,
          status: entry.status,
        });
        break;
    }
  }
  return {
    entries,
    activeRealtimeSessionAtPageStart: page.activeRealtimeSessionAtPageStart ?? null,
    nextCursor: page.nextCursor ?? null,
  };
});
