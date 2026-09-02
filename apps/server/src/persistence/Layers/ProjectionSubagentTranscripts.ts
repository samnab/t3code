import {
  OrchestrationGetSubagentTranscriptResult,
  SubagentTranscriptPageEntry,
  SUBAGENT_TRANSCRIPT_MAX_PAGE_BYTES,
  SUBAGENT_TRANSCRIPT_MAX_PAGE_ITEMS,
  SUBAGENT_TRANSCRIPT_RETAINED_PER_RUN,
  type RuntimeTaskId,
  type SubagentTranscriptItemKind,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { ProjectionSubagentRunRepository } from "../Services/ProjectionSubagentRuns.ts";
import {
  ProjectionSubagentTranscriptStore,
  type IngestSubagentTranscriptResult,
  type ProjectionSubagentTranscriptStoreShape,
  type ReadSubagentTranscriptPageResult,
} from "../Services/ProjectionSubagentTranscripts.ts";
import { sanitizeSubagentTranscriptText } from "../subagentTranscriptSanitization.ts";
import { ProjectionSubagentRunRepositoryLive } from "./ProjectionSubagentRuns.ts";

const MAX_TRACKED_START_RECEIPTS = 1_024;
const MAX_DURABLE_GAP_RANGES_PER_RUN = 128;

interface StoredItemRow {
  readonly kind: SubagentTranscriptItemKind;
  readonly transcriptSequence: number;
  readonly text: string;
  readonly truncated: number;
  readonly upstreamTruncated: number;
  readonly createdAt: string | null;
}

interface SequenceRangeRow {
  readonly fromSequence: number;
  readonly toSequence: number;
}

interface ReplayWatermarkRow {
  readonly runId: RuntimeTaskId;
  readonly watermark: number;
}

type ReadEntry = ReadSubagentTranscriptPageResult["entries"][number];
type MarkerEntry = Extract<ReadEntry, { readonly kind: "evicted" | "gap" }>;

const encodePage = Schema.encodeSync(
  Schema.fromJsonString(OrchestrationGetSubagentTranscriptResult),
);
const encodePageEntry = Schema.encodeSync(Schema.fromJsonString(SubagentTranscriptPageEntry));

const isCovered = (ranges: ReadonlyArray<SequenceRangeRow>, sequence: number) =>
  ranges.some((range) => sequence >= range.fromSequence && sequence <= range.toSequence);

const contiguousWatermark = (
  watermark: number,
  stored: ReadonlyArray<{ readonly transcriptSequence: number }>,
  evictions: ReadonlyArray<SequenceRangeRow>,
) => {
  const storedSet = new Set(stored.map((row) => row.transcriptSequence));
  let candidate = watermark + 1;
  while (storedSet.has(candidate) || isCovered(evictions, candidate)) candidate += 1;
  return candidate - 1;
};

const durableGaps = (
  stored: ReadonlyArray<{ readonly transcriptSequence: number }>,
  evictions: ReadonlyArray<SequenceRangeRow>,
) => {
  const coverage = [
    ...stored.map((row) => ({
      fromSequence: row.transcriptSequence,
      toSequence: row.transcriptSequence,
    })),
    ...evictions,
  ].sort((left, right) => left.fromSequence - right.fromSequence);

  const merged: Array<{ fromSequence: number; toSequence: number }> = [];
  for (const range of coverage) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.fromSequence <= previous.toSequence + 1) {
      previous.toSequence = Math.max(previous.toSequence, range.toSequence);
    } else {
      merged.push({ ...range });
    }
  }

  const gaps: Array<{ fromSequence: number; toSequence: number }> = [];
  let nextExpected = 1;
  for (const range of merged) {
    if (range.fromSequence > nextExpected) {
      gaps.push({ fromSequence: nextExpected, toSequence: range.fromSequence - 1 });
      if (gaps.length >= MAX_DURABLE_GAP_RANGES_PER_RUN) break;
    }
    nextExpected = Math.max(nextExpected, range.toSequence + 1);
  }
  return gaps;
};

const entryBounds = (entry: ReadEntry) =>
  "transcriptSequence" in entry
    ? { start: entry.transcriptSequence, end: entry.transcriptSequence }
    : { start: entry.fromSequence, end: entry.toSequence };

const clampEntry = (
  entry: ReadEntry,
  afterSequence: number | undefined,
  beforeSequence: number | undefined,
): ReadEntry | undefined => {
  const { start, end } = entryBounds(entry);
  const visibleStart = Math.max(start, (afterSequence ?? 0) + 1);
  const visibleEnd = Math.min(end, (beforeSequence ?? Number.POSITIVE_INFINITY) - 1);
  if (visibleStart > visibleEnd) return undefined;
  if ("transcriptSequence" in entry) return entry;
  return { ...entry, fromSequence: visibleStart, toSequence: visibleEnd };
};

const makeProjectionSubagentTranscriptStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* ProjectionSubagentRunRepository;

  // Completed deferreds remain available to late waiters until the bounded map
  // evicts them, so signal-before-wait and wait-before-signal both rendezvous.
  const startReceipts = new Map<string, Deferred.Deferred<boolean>>();

  const evictOldestResolvedReceipt = Effect.fn("evictOldestResolvedReceipt")(function* () {
    if (startReceipts.size <= MAX_TRACKED_START_RECEIPTS) return;
    for (const [runId, deferred] of startReceipts) {
      if (yield* Deferred.isDone(deferred)) {
        startReceipts.delete(runId);
        return;
      }
    }
  });

  const receiptFor = (runId: string) =>
    Effect.gen(function* () {
      const existing = startReceipts.get(runId);
      if (existing !== undefined) return existing;
      const deferred = yield* Deferred.make<boolean>();
      startReceipts.set(runId, deferred);
      yield* evictOldestResolvedReceipt();
      return deferred;
    });

  const signalStartCommitted: ProjectionSubagentTranscriptStoreShape["signalStartCommitted"] = ({
    runId,
  }) =>
    Effect.gen(function* () {
      const deferred = yield* receiptFor(runId);
      const completed = yield* Deferred.succeed(deferred, true);
      yield* evictOldestResolvedReceipt();
      return completed;
    });

  const awaitStartCommitted: ProjectionSubagentTranscriptStoreShape["awaitStartCommitted"] = ({
    runId,
    timeoutMs,
  }) =>
    Effect.gen(function* () {
      const deferred = yield* receiptFor(runId);
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(Duration.millis(timeoutMs)),
        Effect.map((settled) => Option.isSome(settled) && settled.value),
      );
    });

  const evictionsOf = (runId: string) => sql<SequenceRangeRow>`
    SELECT from_sequence AS "fromSequence", to_sequence AS "toSequence"
    FROM subagent_transcript_evictions
    WHERE run_id = ${runId}
    ORDER BY from_sequence
  `;

  const recordEvictionRange = (
    runId: string,
    fromSequence: number,
    toSequence: number,
    evictedAt: string,
    known: Array<{ fromSequence: number; toSequence: number }>,
  ) => {
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
          const bindingMatches =
            binding !== null &&
            binding.managerId === input.managerId &&
            binding.managerRunId === input.managerRunId &&
            binding.activationId === input.activationId &&
            binding.runBirth === input.runBirth;
          if (!bindingMatches) {
            return {
              outcome: "rejected-binding",
              watermark: binding?.lastTranscriptSequence ?? 0,
            } satisfies IngestSubagentTranscriptResult;
          }

          const evictions = yield* evictionsOf(input.runId);
          const knownRanges = evictions.map((range) => ({ ...range }));
          if (isCovered(evictions, input.item.transcriptSequence)) {
            return {
              outcome: "dropped-evicted",
              watermark: binding.lastTranscriptSequence ?? 0,
            } satisfies IngestSubagentTranscriptResult;
          }

          const sanitized = sanitizeSubagentTranscriptText({
            text: input.item.text,
            upstreamTruncated: input.item.upstreamTruncated,
          });
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
              ${sanitized.upstreamTruncated ? 1 : 0},
              ${input.item.createdAt},
              ${input.observedAt}
            )
            RETURNING transcript_sequence
          `;

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
              } else {
                yield* flushRange();
                rangeStart = row.transcriptSequence;
                rangeEnd = rangeStart;
              }
            }
            yield* flushRange();
            yield* sql`
              DELETE FROM subagent_transcript_items
              WHERE run_id = ${input.runId}
                AND transcript_sequence <= ${evictedRows.at(-1)!.transcriptSequence}
            `;
          }

          const storedAfter = yield* sql<{ readonly transcriptSequence: number }>`
            SELECT transcript_sequence AS "transcriptSequence"
            FROM subagent_transcript_items
            WHERE run_id = ${input.runId}
            ORDER BY transcript_sequence
          `;
          const currentEvictions = yield* evictionsOf(input.runId);
          const watermark = contiguousWatermark(
            binding.lastTranscriptSequence ?? 0,
            storedAfter,
            currentEvictions,
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
        Effect.mapError(
          toPersistenceSqlError("ProjectionSubagentTranscriptStore.ingestItem:query"),
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
    );

  const readWatermarksForManager: ProjectionSubagentTranscriptStoreShape["readWatermarksForManager"] =
    (input) =>
      sql<ReplayWatermarkRow>`
        SELECT
          run_id AS "runId",
          COALESCE(last_transcript_sequence, 0) AS "watermark"
        FROM projection_subagent_runs
        WHERE thread_id = ${input.threadId}
          AND owner_id = ${input.managerId}
          AND run_birth IS NOT NULL
          AND history_availability = 'durable'
        ORDER BY run_number
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            runId: row.runId,
            watermark: row.watermark,
          })),
        ),
        Effect.mapError(
          toPersistenceSqlError("ProjectionSubagentTranscriptStore.readWatermarksForManager:query"),
        ),
      );

  const readPage: ProjectionSubagentTranscriptStoreShape["readPage"] = (input) =>
    Effect.gen(function* () {
      const binding = yield* runs.getRunBinding({ runId: input.runId });
      if (binding === null || binding.threadId !== input.threadId) {
        return { unavailable: "unknown-run" } as const;
      }
      if (binding.historyAvailability !== "durable") {
        return { unavailable: "unavailable" } as const;
      }

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
        ORDER BY transcript_sequence
      `;
      const items: ReadonlyArray<ReadEntry> = rows.map((row) => ({
        kind: row.kind,
        transcriptSequence: row.transcriptSequence,
        text: row.text,
        truncated: row.truncated === 1,
        upstreamTruncated: row.upstreamTruncated === 1,
        createdAt: row.createdAt,
      }));
      const evictionRanges = yield* evictionsOf(input.runId);
      const evictions: ReadonlyArray<MarkerEntry> = evictionRanges.map((range) => ({
        kind: "evicted",
        ...range,
      }));
      const gaps: ReadonlyArray<MarkerEntry> = durableGaps(rows, evictionRanges).map((range) => ({
        kind: "gap",
        ...range,
      }));
      const ascending = [...items, ...evictions, ...gaps]
        .map((entry) => clampEntry(entry, input.afterSequence, input.beforeSequence))
        .filter((entry): entry is ReadEntry => entry !== undefined)
        .sort((left, right) => entryBounds(left).start - entryBounds(right).start);
      const forward = input.afterSequence !== undefined;
      const ordered = forward ? ascending : ascending.toReversed();
      const watermark = binding.lastTranscriptSequence ?? 0;
      const envelopeBytes =
        Buffer.byteLength(encodePage({ entries: [], watermark, hasMore: false }), "utf8") -
        Buffer.byteLength("false", "utf8");
      const selected = new Array<ReadEntry>();
      let consumed = 0;
      let entriesBytes = 0;
      for (const entry of ordered) {
        if (selected.length >= SUBAGENT_TRANSCRIPT_MAX_PAGE_ITEMS) break;
        const entryBytes = Buffer.byteLength(encodePageEntry(entry), "utf8");
        const hasMore = consumed + 1 < ordered.length;
        const candidateBytes =
          envelopeBytes +
          entriesBytes +
          (selected.length > 0 ? 1 : 0) +
          entryBytes +
          (hasMore ? 4 : 5);
        if (candidateBytes > SUBAGENT_TRANSCRIPT_MAX_PAGE_BYTES) break;
        selected.push(entry);
        entriesBytes += (selected.length > 1 ? 1 : 0) + entryBytes;
        consumed += 1;
      }
      if (!forward) selected.reverse();

      const page = {
        entries: selected,
        watermark,
        hasMore: consumed < ordered.length,
      } satisfies ReadSubagentTranscriptPageResult;
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
    readWatermarksForManager,
    readPage,
  } satisfies ProjectionSubagentTranscriptStoreShape;
});

export const ProjectionSubagentTranscriptStoreLive = Layer.effect(
  ProjectionSubagentTranscriptStore,
  makeProjectionSubagentTranscriptStore,
).pipe(Layer.provide(ProjectionSubagentRunRepositoryLive));
