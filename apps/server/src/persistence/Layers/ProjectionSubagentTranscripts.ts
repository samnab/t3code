import {
  SUBAGENT_TRANSCRIPT_FIELD_MAX_CODE_POINTS,
  SUBAGENT_TRANSCRIPT_MAX_PAGE_BYTES,
  SUBAGENT_TRANSCRIPT_MAX_PAGE_ITEMS,
  SUBAGENT_TRANSCRIPT_RETAINED_PER_RUN,
  type SubagentTranscriptItemKind,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import { ProjectionSubagentRunRepository } from "../Services/ProjectionSubagentRuns.ts";
import {
  ProjectionSubagentTranscriptStore,
  type IngestSubagentTranscriptResult,
  type ProjectionSubagentTranscriptStoreShape,
  type ReadSubagentTranscriptPageResult,
} from "../Services/ProjectionSubagentTranscripts.ts";
import { sanitizeSubagentTranscriptField } from "../subagentTranscriptSanitization.ts";
import { ProjectionSubagentRunRepositoryLive } from "./ProjectionSubagentRuns.ts";

/** Receipts are bounded; late waiters resolve through completed deferreds. */
const MAX_TRACKED_START_RECEIPTS = 1_024;

interface StoredItemRow {
  readonly kind: SubagentTranscriptItemKind;
  readonly transcriptSequence: number;
  readonly text: string;
  readonly truncated: number;
  readonly upstreamTruncated: number;
  readonly createdAt: string | null;
}

interface EvictionRangeRow {
  readonly fromSequence: number;
  readonly toSequence: number;
}

type ReadEntry = ReadSubagentTranscriptPageResult["entries"][number];
type EvictionMarker = Extract<ReadEntry, { readonly kind: "evicted" | "gap" }>;
type ItemEntry = Exclude<ReadEntry, EvictionMarker>;

const encodedEntryBytes = (entries: ReadonlyArray<ReadEntry>, candidate: ReadEntry) =>
  Buffer.byteLength(JSON.stringify([...entries, candidate]), "utf8");

const isEvicted = (ranges: ReadonlyArray<EvictionRangeRow>, sequence: number) =>
  ranges.some((range) => sequence >= range.fromSequence && sequence <= range.toSequence);

/** Highest contiguously covered sequence: stored row or eviction tombstone. */
const contiguousWatermark = (
  watermark: number,
  stored: ReadonlyArray<{ readonly transcriptSequence: number }>,
  ranges: ReadonlyArray<EvictionRangeRow>,
) => {
  const storedSet = new Set(stored.map((row) => row.transcriptSequence));
  let candidate = watermark + 1;
  while (storedSet.has(candidate) || isEvicted(ranges, candidate)) {
    candidate += 1;
  }
  return candidate - 1;
};

const makeProjectionSubagentTranscriptStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* ProjectionSubagentRunRepository;

  // ── durable-start receipts (the projector signals, ingestion waits) ──

  const startReceipts = new Map<string, Deferred.Deferred<boolean>>();

  const receiptFor = (runId: string) =>
    Effect.gen(function* () {
      const existing = startReceipts.get(runId);
      if (existing !== undefined) return existing;
      const deferred = yield* Deferred.make<boolean>();
      if (startReceipts.size >= MAX_TRACKED_START_RECEIPTS) {
        const oldest = startReceipts.keys().next().value;
        if (oldest !== undefined) startReceipts.delete(oldest);
      }
      startReceipts.set(runId, deferred);
      return deferred;
    });

  const signalStartCommitted: ProjectionSubagentTranscriptStoreShape["signalStartCommitted"] = ({
    runId,
  }) => receiptFor(runId).pipe(Effect.flatMap((deferred) => Deferred.succeed(deferred, true)));

  const awaitStartCommitted: ProjectionSubagentTranscriptStoreShape["awaitStartCommitted"] = ({
    runId,
    timeoutMs,
  }) =>
    Effect.gen(function* () {
      const deferred = yield* receiptFor(runId);
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.map((settled) => Option.isSome(settled) && settled.value === true),
      );
    });

  // ── ingest ────────────────────────────────────────────────────

  const evictionsOf = (runId: string) => sql<EvictionRangeRow>`
    SELECT from_sequence AS "fromSequence", to_sequence AS "toSequence"
    FROM subagent_transcript_evictions
    WHERE run_id = ${runId}
  `;

  const recordEvictionRange = (
    runId: string,
    fromSequence: number,
    toSequence: number,
    evictedAt: string,
    known: Array<{ fromSequence: number; toSequence: number }>,
  ) => {
    // Coalesce with an adjacent predecessor range; ranges only ever cover
    // observed sequences, so adjacency (to == from - 1) can never bridge a
    // never-observed gap.
    const adjacent = known.find((range) => range.toSequence === fromSequence - 1);
    if (adjacent !== undefined) {
      adjacent.toSequence = toSequence;
      return sql`
        UPDATE subagent_transcript_evictions
        SET to_sequence = ${toSequence}, evicted_at = ${evictedAt}
        WHERE run_id = ${runId} AND from_sequence = ${adjacent.fromSequence}
      `;
    }
    known.push({ fromSequence, toSequence });
    return sql`
      INSERT INTO subagent_transcript_evictions
        (run_id, from_sequence, to_sequence, evicted_at)
      VALUES (${runId}, ${fromSequence}, ${toSequence}, ${evictedAt})
      ON CONFLICT (run_id, from_sequence) DO UPDATE SET
        to_sequence = MAX(subagent_transcript_evictions.to_sequence, excluded.to_sequence),
        evicted_at = excluded.evicted_at
    `;
  };

  const ingestItem: ProjectionSubagentTranscriptStoreShape["ingestItem"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const binding = yield* runs.getRunBinding({ runId: input.runId });
          if (binding === null || binding.runBirth !== input.runBirth) {
            return {
              outcome: "rejected-binding",
              watermark: binding?.lastTranscriptSequence ?? 0,
            } satisfies IngestSubagentTranscriptResult;
          }

          const evictions = yield* evictionsOf(input.runId);
          const knownRanges = evictions.map((range) => ({ ...range }));
          if (isEvicted(evictions, input.item.transcriptSequence)) {
            return {
              outcome: "dropped-evicted",
              watermark: binding.lastTranscriptSequence ?? 0,
            } satisfies IngestSubagentTranscriptResult;
          }

          // T3-boundary redaction before the code-point cap; the producer's
          // own truncation flags are preserved alongside T3's.
          const sanitized = sanitizeSubagentTranscriptField(
            input.item.text,
            SUBAGENT_TRANSCRIPT_FIELD_MAX_CODE_POINTS,
          );
          const inserted = yield* sql`
          INSERT OR IGNORE INTO subagent_transcript_items (
            run_id,
            transcript_sequence,
            kind,
            text,
            truncated,
            upstream_truncated,
            created_at,
            stored_at
          ) VALUES (
            ${input.runId},
            ${input.item.transcriptSequence},
            ${input.item.kind},
            ${sanitized.text},
            ${sanitized.truncated || input.item.truncated ? 1 : 0},
            ${input.item.upstreamTruncated ? 1 : 0},
            ${input.item.createdAt},
            ${input.observedAt}
          )
          RETURNING transcript_sequence
        `;

          // Retention: when the cap is exceeded, evict the lowest retained
          // sequences and tombstone them in the same transaction. Ranges only
          // ever cover stored (observed) sequences, so they never bridge a
          // never-observed gap; adjacent evicted rows coalesce into one range.
          const retained = yield* sql<{ readonly transcriptSequence: number }>`
          SELECT transcript_sequence AS "transcriptSequence"
          FROM subagent_transcript_items
          WHERE run_id = ${input.runId}
          ORDER BY transcript_sequence
        `;
          if (retained.length > SUBAGENT_TRANSCRIPT_RETAINED_PER_RUN) {
            const evictedRows = retained.slice(
              0,
              retained.length - SUBAGENT_TRANSCRIPT_RETAINED_PER_RUN,
            );
            let rangeStart = evictedRows[0]!.transcriptSequence;
            let rangeEnd = rangeStart;
            const flushRange = () =>
              recordEvictionRange(input.runId, rangeStart, rangeEnd, input.observedAt, knownRanges);
            for (const row of evictedRows.slice(1)) {
              if (row.transcriptSequence === rangeEnd + 1) {
                rangeEnd = row.transcriptSequence;
                continue;
              }
              yield* flushRange();
              rangeStart = row.transcriptSequence;
              rangeEnd = rangeStart;
            }
            yield* flushRange();
            yield* sql`
            DELETE FROM subagent_transcript_items
            WHERE run_id = ${input.runId}
              AND transcript_sequence <= ${evictedRows[evictedRows.length - 1]!.transcriptSequence}
          `;
          }

          const storedAfter = yield* sql<{ readonly transcriptSequence: number }>`
          SELECT transcript_sequence AS "transcriptSequence"
          FROM subagent_transcript_items
          WHERE run_id = ${input.runId}
            AND transcript_sequence > ${binding.lastTranscriptSequence ?? 0}
        `;
          const watermark = contiguousWatermark(
            binding.lastTranscriptSequence ?? 0,
            storedAfter,
            yield* evictionsOf(input.runId),
          );
          if (watermark > (binding.lastTranscriptSequence ?? 0)) {
            yield* runs.advanceTranscriptWatermark({
              runId: input.runId,
              lastTranscriptSequence: watermark,
            });
          }

          return {
            outcome: inserted.length > 0 ? "stored" : "ignored-duplicate",
            watermark,
          } satisfies IngestSubagentTranscriptResult;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? toPersistenceDecodeError("ProjectionSubagentTranscriptStore.ingestItem:decodeRow")(
                cause,
              )
            : toPersistenceSqlError("ProjectionSubagentTranscriptStore.ingestItem:query")(cause),
        ),
      );

  const getWatermark: ProjectionSubagentTranscriptStoreShape["getWatermark"] = ({ runId }) =>
    Effect.map(runs.getRunBinding({ runId }), (binding) => binding?.lastTranscriptSequence ?? 0);

  const readWatermarks: ProjectionSubagentTranscriptStoreShape["readWatermarks"] = (runIds) =>
    Effect.forEach(runIds, (runId) =>
      Effect.map(runs.getRunBinding({ runId }), (binding) => ({
        runId,
        watermark: binding?.lastTranscriptSequence ?? 0,
      })),
    ).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionSubagentTranscriptStore.readWatermarks:query"),
      ),
    );

  const readPage: ProjectionSubagentTranscriptStoreShape["readPage"] = (input) =>
    Effect.gen(function* () {
      const binding = yield* runs.getRunBinding({ runId: input.runId });
      if (binding === null) {
        return { unavailable: "unknown-run" } as const;
      }
      if (binding.historyAvailability !== "durable") {
        return { unavailable: "unavailable" } as const;
      }
      const after = input.afterSequence ?? 0;
      const rows = yield* sql<StoredItemRow>`
        SELECT
          kind,
          transcript_sequence AS "transcriptSequence",
          text,
          truncated,
          upstream_truncated AS "upstreamTruncated",
          created_at AS "createdAt"
        FROM subagent_transcript_items
        WHERE run_id = ${input.runId}
          AND transcript_sequence > ${after}
        ORDER BY transcript_sequence
        LIMIT ${SUBAGENT_TRANSCRIPT_MAX_PAGE_ITEMS + 1}
      `;
      const rawEvictions = yield* evictionsOf(input.runId);
      // Clamp ranges to the exclusive bound so a range overlapping the bound
      // renders only its visible part.
      const evictions = rawEvictions
        .filter((range) => range.toSequence > after)
        .map(
          (range): EvictionMarker => ({
            kind: "evicted",
            fromSequence: Math.max(range.fromSequence, after + 1),
            toSequence: range.toSequence,
          }),
        );

      const entries = new Array<ReadEntry>();
      // Merge stored items with eviction and gap markers in sequence order. A
      // gap marker covers never-observed sequences between two covered
      // positions; the unknown tail above the last entry is never a gap.
      let lastCovered = after;
      let itemIndex = 0;
      let evictionIndex = 0;
      let capped = false;
      while (itemIndex < rows.length || evictionIndex < evictions.length) {
        const item: ItemEntry | undefined =
          itemIndex < rows.length
            ? {
                kind: rows[itemIndex]!.kind,
                transcriptSequence: rows[itemIndex]!.transcriptSequence,
                text: rows[itemIndex]!.text,
                truncated: rows[itemIndex]!.truncated === 1,
                upstreamTruncated: rows[itemIndex]!.upstreamTruncated === 1,
                createdAt: rows[itemIndex]!.createdAt,
              }
            : undefined;
        const eviction = evictions[evictionIndex];
        const itemIsNext =
          item !== undefined &&
          (eviction === undefined || item.transcriptSequence < eviction.fromSequence);
        const next: ReadEntry = itemIsNext ? item! : eviction!;
        const nextSequence = itemIsNext ? item!.transcriptSequence : eviction!.fromSequence;
        if (nextSequence > lastCovered + 1 && entries.length > 0) {
          entries.push({
            kind: "gap",
            fromSequence: lastCovered + 1,
            toSequence: nextSequence - 1,
          });
        }
        if (
          entries.length >= SUBAGENT_TRANSCRIPT_MAX_PAGE_ITEMS ||
          encodedEntryBytes(entries, next) > SUBAGENT_TRANSCRIPT_MAX_PAGE_BYTES
        ) {
          capped = entries.length > 0;
          break;
        }
        entries.push(next);
        lastCovered = itemIsNext
          ? item!.transcriptSequence
          : Math.max(lastCovered, eviction!.toSequence);
        if (itemIsNext) itemIndex += 1;
        else evictionIndex += 1;
      }

      const page: ReadSubagentTranscriptPageResult = {
        entries,
        watermark: binding.lastTranscriptSequence ?? 0,
        hasMore: capped || itemIndex < rows.length || evictionIndex < evictions.length,
      };
      return page;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionSubagentTranscriptStore.readPage:query")),
    );

  return {
    signalStartCommitted,
    awaitStartCommitted,
    ingestItem,
    getWatermark,
    readWatermarks,
    readPage,
  } satisfies ProjectionSubagentTranscriptStoreShape;
});

export const ProjectionSubagentTranscriptStoreLive = Layer.effect(
  ProjectionSubagentTranscriptStore,
  makeProjectionSubagentTranscriptStore,
).pipe(Layer.provide(ProjectionSubagentRunRepositoryLive));
