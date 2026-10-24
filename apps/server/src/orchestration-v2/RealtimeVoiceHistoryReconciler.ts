import type { OrchestrationV2ProviderThread, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import { realtimeVoiceKey, stitchRealtimeVoiceHistory } from "./realtimeVoiceStitch.ts";

// 40 pages of the adapter's 75-row bound.
const MAX_REALTIME_HISTORY_PAGES = 40;

type RealtimeVoiceItem = Extract<OrchestrationV2TurnItem, { readonly type: "realtime_voice" }>;
type HistoryEntry = ProviderAdapter.ProviderAdapterV2RealtimeHistoryEntry;

class RealtimeVoiceReconciliationError extends Schema.TaggedError<RealtimeVoiceReconciliationError>()(
  "RealtimeVoiceReconciliationError",
  {
    reason: Schema.Literals(["binding_mismatch", "inconsistent_history", "history_truncated"]),
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

/**
 * Reads the bound provider history and returns the canonical voice items the projection is
 * missing, stitched against recorded coding turns. Output is descriptive turn items only: nothing
 * here starts, adopts, or queues provider work. Call outside the provider's serial notification
 * reader, and write the result through the same guarded ingestion as live voice.
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

    const byIdentity = new Map<string, HistoryEntry>();
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page === MAX_REALTIME_HISTORY_PAGES)
        return yield* new RealtimeVoiceReconciliationError({ reason: "history_truncated" });
      const result: ProviderAdapter.ProviderAdapterV2RealtimeHistoryResult =
        yield* input.readRealtimeHistoryPage({ providerThread, cursor });
      if (
        result.threadId !== threadId ||
        result.providerThreadId !== providerThread.id ||
        result.providerInstanceId !== providerThread.providerInstanceId ||
        result.nativeThreadId !== nativeThreadId
      )
        return yield* new RealtimeVoiceReconciliationError({ reason: "binding_mismatch" });
      if (result.type === "unsupported") return [];
      for (const entry of result.entries) {
        if (!Number.isSafeInteger(entry.position) || entry.position < 0)
          return yield* new RealtimeVoiceReconciliationError({ reason: "inconsistent_history" });
        if (
          entry.type === "realtime" &&
          (!isSourceId(entry.item.id) || !isSourceId(entry.item.realtimeSessionId))
        )
          return yield* new RealtimeVoiceReconciliationError({ reason: "inconsistent_history" });
        const identity = entryIdentity(entry);
        const seen = byIdentity.get(identity);
        // Overlapping pages repeat entries; the same entry at a new position is not the same history.
        if (seen !== undefined && seen.position !== entry.position)
          return yield* new RealtimeVoiceReconciliationError({ reason: "inconsistent_history" });
        byIdentity.set(identity, entry);
      }
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    const entries = [...byIdentity.values()].sort((left, right) => left.position - right.position);
    if (
      entries.some((entry, index) => index > 0 && entries[index - 1]!.position === entry.position)
    )
      return yield* new RealtimeVoiceReconciliationError({ reason: "inconsistent_history" });

    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const { turnItems, providerTurns } = yield* projectionStore.getThreadRecords(threadId, [
      "turnItems",
      "providerTurns",
    ]);
    const nativeTurnByProviderTurn = new Map(
      providerTurns.flatMap((turn) =>
        turn.providerThreadId === providerThread.id && turn.nativeTurnRef?.nativeId != null
          ? [[turn.id, turn.nativeTurnRef.nativeId] as const]
          : [],
      ),
    );
    const runsByNativeTurn = new Map<string, Set<string>>();
    for (const item of turnItems) {
      const nativeTurnId =
        item.providerTurnId === null
          ? undefined
          : nativeTurnByProviderTurn.get(item.providerTurnId);
      if (nativeTurnId === undefined || item.runId === null) continue;
      const runs = runsByNativeTurn.get(nativeTurnId) ?? new Set();
      runsByNativeTurn.set(nativeTurnId, runs.add(item.runId));
    }
    const turnSpans = new Map<string, { first: number; last: number }>();
    const codingOrdinals: Array<number> = [];
    const existing = new Map<string, RealtimeVoiceItem>();
    for (const item of turnItems) {
      if (item.type === "realtime_voice") {
        if (
          item.providerInstanceId === providerThread.providerInstanceId &&
          item.nativeThreadId === nativeThreadId
        )
          existing.set(realtimeVoiceKey(item.realtimeSessionId, item.nativeRealtimeItemId), item);
        continue;
      }
      codingOrdinals.push(item.ordinal);
      const nativeTurnId =
        item.providerTurnId === null
          ? undefined
          : nativeTurnByProviderTurn.get(item.providerTurnId);
      if (nativeTurnId !== undefined) {
        const span = turnSpans.get(nativeTurnId);
        turnSpans.set(nativeTurnId, {
          first: Math.min(span?.first ?? item.ordinal, item.ordinal),
          last: Math.max(span?.last ?? item.ordinal, item.ordinal),
        });
      }
    }
    // A run's opening user message carries no provider turn; it still starts that turn.
    for (const item of turnItems) {
      if (item.type === "realtime_voice" || item.runId === null) continue;
      for (const [nativeTurnId, runs] of runsByNativeTurn) {
        const span = turnSpans.get(nativeTurnId);
        if (span !== undefined && runs.has(item.runId) && item.ordinal < span.first)
          turnSpans.set(nativeTurnId, { ...span, first: item.ordinal });
      }
    }

    const missing = entries.filter(
      (entry): entry is Extract<HistoryEntry, { readonly type: "realtime" }> =>
        entry.type === "realtime" &&
        existing.get(realtimeVoiceKey(entry.item.realtimeSessionId, entry.item.id))
          ?.captureState !== "canonical_completed",
    );
    if (missing.length === 0) return [];
    const placements = stitchRealtimeVoiceHistory({
      entries,
      turnSpans,
      codingOrdinals,
      existingVoice: new Map(
        [...existing].flatMap(([key, item]) =>
          // Only committed neighbors bound a gap; a tail about to be upgraded keeps its own slot.
          item.captureState === "canonical_completed" ? [[key, item.ordinal] as const] : [],
        ),
      ),
    });
    const now = yield* DateTime.now;
    return missing.map((entry): RealtimeVoiceItem => {
      const { id: nativeItemId, realtimeSessionId, ...content } = entry.item;
      const ordinal = placements.get(realtimeVoiceKey(realtimeSessionId, nativeItemId)) ?? null;
      return {
        id: idAllocator.derive.realtimeVoiceTurnItem({
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
        sourceOrder: ordinal === null ? "unreconciled" : "provider_anchored",
        timestampProvenance: "recovered",
      };
    });
  },
);
