import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import {
  realtimeVoiceAnchor,
  realtimeVoiceKey,
  stitchRealtimeVoiceHistory,
} from "./realtimeVoiceStitch.ts";

// 40 pages of the adapter's 75-row bound per pass.
const MAX_REALTIME_HISTORY_PAGES = 40;

type RealtimeVoiceItem = Extract<OrchestrationV2TurnItem, { readonly type: "realtime_voice" }>;
type HistoryEntry = ProviderAdapter.ProviderAdapterV2RealtimeHistoryEntry;

class RealtimeVoiceReconciliationError extends Schema.TaggedError<RealtimeVoiceReconciliationError>()(
  "RealtimeVoiceReconciliationError",
  {
    reason: Schema.Literals(["binding_mismatch", "inconsistent_history"]),
  },
) {
  override get message(): string {
    return `Realtime voice history reconciliation failed: ${this.reason}.`;
  }
}

// Opaque native identity: never trim it into a different canonical key.
const isSourceId = (value: string) => value.length > 0 && value.trim() === value;

const entryIdentity = (entry: HistoryEntry) =>
  (entry.type === "realtime"
    ? ["realtime", entry.item.realtimeSessionId, entry.item.id]
    : entry.type === "item"
      ? ["item", entry.nativeTurnId, entry.nativeItemId]
      : [entry.type, entry.nativeTurnId]
  )
    .map((part) => `${part.length}:${part}`)
    .join("");

type ReadFrom =
  | { readonly type: "unsupported" }
  | { readonly type: "stale" }
  | {
      readonly type: "read";
      readonly pages: ReadonlyArray<{
        readonly cursor: string | null;
        readonly entries: ReadonlyArray<HistoryEntry>;
      }>;
      readonly complete: boolean;
    };

/**
 * One reconciliation pass over the bound provider history. It resumes at the stored resume point
 * and reads at most 40 pages, so a pass costs the entries added since the last pass plus one
 * re-read page. Returns the canonical voice items the projection is missing, stitched against
 * recorded coding turns, the next resume point, and whether the pass reached the end.
 * Output is descriptive turn items only: nothing here starts, adopts, or queues provider work.
 * Call outside the provider's serial notification reader, write the items through the same
 * guarded ingestion as live voice, and store the resume point only after they are written.
 */
export const reconcileRealtimeVoiceHistory = Effect.fn("RealtimeVoiceHistoryReconciler.reconcile")(
  function* (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly readRealtimeHistoryPage: NonNullable<
      ProviderAdapter.ProviderAdapterV2SessionRuntime["readRealtimeHistoryPage"]
    >;
  }) {
    const { providerThread } = input;
    const threadId = providerThread.appThreadId;
    const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
    if (threadId === null || nativeThreadId === undefined || nativeThreadId === null)
      return yield* new RealtimeVoiceReconciliationError({ reason: "binding_mismatch" });
    const key: ProjectionStore.RealtimeVoiceHistoryKey = {
      threadId,
      providerInstanceId: providerThread.providerInstanceId,
      nativeThreadId,
    };
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;

    const readFrom = Effect.fnUntraced(function* (
      start: ProjectionStore.RealtimeVoiceHistoryResume | null,
    ) {
      const pages: Array<{ cursor: string | null; entries: ReadonlyArray<HistoryEntry> }> = [];
      let cursor = start?.cursor ?? null;
      for (let page = 0; page < MAX_REALTIME_HISTORY_PAGES; page += 1) {
        const result: ProviderAdapter.ProviderAdapterV2RealtimeHistoryResult =
          yield* input.readRealtimeHistoryPage({ providerThread, cursor });
        if (
          result.threadId !== threadId ||
          result.providerThreadId !== providerThread.id ||
          result.providerInstanceId !== providerThread.providerInstanceId ||
          result.nativeThreadId !== nativeThreadId
        )
          return yield* new RealtimeVoiceReconciliationError({ reason: "binding_mismatch" });
        if (result.type === "unsupported") return { type: "unsupported" } satisfies ReadFrom;
        for (const entry of result.entries) {
          if (!Number.isSafeInteger(entry.position) || entry.position < 0)
            return yield* new RealtimeVoiceReconciliationError({ reason: "inconsistent_history" });
          if (
            entry.type === "realtime" &&
            (!isSourceId(entry.item.id) || !isSourceId(entry.item.realtimeSessionId))
          )
            return yield* new RealtimeVoiceReconciliationError({ reason: "inconsistent_history" });
        }
        // A cursor only still means the same place when its page starts where it did.
        const first = result.entries[0];
        if (
          page === 0 &&
          start?.cursor != null &&
          start.firstIdentity !== null &&
          (first === undefined ||
            entryIdentity(first) !== start.firstIdentity ||
            first.position !== start.firstPosition)
        )
          return { type: "stale" } satisfies ReadFrom;
        pages.push({ cursor, entries: result.entries });
        if (result.nextCursor === null)
          return { type: "read", pages, complete: true } satisfies ReadFrom;
        cursor = result.nextCursor;
      }
      return { type: "read", pages, complete: false } satisfies ReadFrom;
    });

    const stored = yield* projectionStore.getRealtimeVoiceHistoryResume(key);
    // A cursor the provider no longer honors falls back to reading the whole history.
    const resumed =
      stored === null
        ? undefined
        : yield* readFrom(stored).pipe(
            Effect.map((read) => (read.type === "stale" ? undefined : read)),
            Effect.catch(() => Effect.succeed(undefined)),
          );
    const read = resumed ?? (yield* readFrom(null));
    if (read.type !== "read") return { items: [], complete: true, resume: null };
    const start = resumed === undefined ? null : stored;

    const byIdentity = new Map<string, HistoryEntry>();
    for (const entry of read.pages.flatMap((page) => page.entries)) {
      const identity = entryIdentity(entry);
      const seen = byIdentity.get(identity);
      // Overlapping pages repeat entries; the same entry at a new position is not the same history.
      if (seen !== undefined && seen.position !== entry.position)
        return yield* new RealtimeVoiceReconciliationError({ reason: "inconsistent_history" });
      byIdentity.set(identity, entry);
    }
    const entries = [...byIdentity.values()].sort((left, right) => left.position - right.position);
    if (
      entries.some((entry, index) => index > 0 && entries[index - 1]!.position === entry.position)
    )
      return yield* new RealtimeVoiceReconciliationError({ reason: "inconsistent_history" });

    // The next pass re-reads the last page, so its first entry can prove the cursor still holds.
    const last = read.pages.at(-1)!;
    const resumeFirst = last.entries[0];
    const plan = planRealtimeVoiceRecovery({
      providerThread,
      threadId,
      nativeThreadId,
      entries,
      index: yield* projectionStore.getRealtimeVoiceStitchIndex({
        threadId,
        providerThreadId: providerThread.id,
      }),
      initialAnchor: start?.anchorOrdinal ?? undefined,
      resumeBefore: resumeFirst?.position,
      deriveId: idAllocator.derive.realtimeVoiceTurnItem,
      now: yield* DateTime.now,
    });
    return {
      items: plan.items,
      complete: read.complete,
      resume: {
        key,
        resume: {
          cursor: last.cursor,
          firstIdentity: resumeFirst === undefined ? null : entryIdentity(resumeFirst),
          firstPosition: resumeFirst?.position ?? null,
          anchorOrdinal: plan.resumeAnchor ?? null,
        },
      },
    };
  },
);

/**
 * Turns merged native history and lean projection rows into the voice items still missing, and
 * the stitch anchor that speech after `resumeBefore` starts from.
 */
export function planRealtimeVoiceRecovery(input: {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly threadId: ThreadId;
  readonly nativeThreadId: string;
  readonly entries: ReadonlyArray<HistoryEntry>;
  readonly index: ReadonlyArray<ProjectionStore.RealtimeVoiceStitchRow>;
  readonly initialAnchor?: number | undefined;
  readonly resumeBefore?: number | undefined;
  readonly deriveId: IdAllocator.IdAllocatorV2["Service"]["derive"]["realtimeVoiceTurnItem"];
  readonly now: DateTime.Utc;
}): {
  readonly items: ReadonlyArray<RealtimeVoiceItem>;
  readonly resumeAnchor: number | undefined;
} {
  const { providerThread, threadId, nativeThreadId, entries, index, now } = input;
  const nativeTurnsByRun = new Map<string, Set<string>>();
  const turnSpans = new Map<string, { first: number; last: number }>();
  const codingOrdinals: Array<number> = [];
  const existing = new Map<string, ProjectionStore.RealtimeVoiceStitchRow>();
  for (const row of index) {
    if (row.voice !== null) {
      if (
        row.voice.providerInstanceId === providerThread.providerInstanceId &&
        row.voice.nativeThreadId === nativeThreadId
      )
        existing.set(
          realtimeVoiceKey(row.voice.realtimeSessionId, row.voice.nativeRealtimeItemId),
          row,
        );
      continue;
    }
    codingOrdinals.push(row.ordinal);
    if (row.nativeTurnId === null) continue;
    const span = turnSpans.get(row.nativeTurnId);
    turnSpans.set(row.nativeTurnId, {
      first: Math.min(span?.first ?? row.ordinal, row.ordinal),
      last: Math.max(span?.last ?? row.ordinal, row.ordinal),
    });
    if (row.runId !== null)
      nativeTurnsByRun.set(
        row.runId,
        (nativeTurnsByRun.get(row.runId) ?? new Set()).add(row.nativeTurnId),
      );
  }
  // A run's opening user message carries no provider turn; it still starts that turn.
  for (const row of index) {
    if (row.voice !== null || row.runId === null) continue;
    for (const nativeTurnId of nativeTurnsByRun.get(row.runId) ?? []) {
      const span = turnSpans.get(nativeTurnId)!;
      if (row.ordinal < span.first) turnSpans.set(nativeTurnId, { ...span, first: row.ordinal });
    }
  }
  const resumeAnchor = realtimeVoiceAnchor(
    input.resumeBefore === undefined
      ? entries
      : entries.filter((entry) => entry.position < input.resumeBefore!),
    turnSpans,
    input.initialAnchor,
  );

  const missing = entries.filter(
    (entry): entry is Extract<HistoryEntry, { readonly type: "realtime" }> =>
      entry.type === "realtime" &&
      existing.get(realtimeVoiceKey(entry.item.realtimeSessionId, entry.item.id))?.voice
        ?.captureState !== "canonical_completed",
  );
  if (missing.length === 0) return { items: [], resumeAnchor };
  const placements = stitchRealtimeVoiceHistory({
    entries,
    turnSpans,
    codingOrdinals,
    occupiedOrdinals: new Set(index.map((row) => row.ordinal)),
    initialAnchor: input.initialAnchor,
    existingVoice: new Map(
      [...existing].flatMap(([key, row]) =>
        // Only committed neighbors bound a gap; a tail about to be upgraded keeps its own slot.
        row.voice?.captureState === "canonical_completed" ? [[key, row.ordinal] as const] : [],
      ),
    ),
  });
  const items = missing.map((entry): RealtimeVoiceItem => {
    const { id: nativeItemId, realtimeSessionId, ...content } = entry.item;
    const key = realtimeVoiceKey(realtimeSessionId, nativeItemId);
    // A stored tail upgraded by its commit keeps the slot and time it was observed at.
    const tail = existing.get(key);
    const ordinal = tail?.ordinal ?? placements.get(key) ?? null;
    return {
      id: input.deriveId({
        providerInstanceId: providerThread.providerInstanceId,
        nativeThreadId,
        realtimeSessionId,
        nativeItemId,
      }),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: {
        driver: providerThread.driver,
        nativeId: nativeItemId,
        strength: "strong",
      },
      parentItemId: null,
      ordinal: ordinal ?? 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: now,
      updatedAt: now,
      type: "realtime_voice",
      providerInstanceId: providerThread.providerInstanceId,
      nativeThreadId,
      realtimeSessionId,
      nativeRealtimeItemId: nativeItemId,
      content,
      captureState: "canonical_completed",
      historyCoverage: "provider_history",
      sourceOrder:
        tail === undefined
          ? ordinal === null
            ? "unreconciled"
            : "provider_anchored"
          : tail.voice?.sourceOrder === "provider_anchored"
            ? "provider_anchored"
            : "unreconciled",
      timestampProvenance:
        tail === undefined || tail.voice?.timestampProvenance === "recovered"
          ? "recovered"
          : "observed",
    };
  });
  return { items, resumeAnchor };
}
