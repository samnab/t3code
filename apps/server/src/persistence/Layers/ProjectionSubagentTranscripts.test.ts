import {
  ProviderDriverKind,
  RuntimeTaskId,
  SUBAGENT_TRANSCRIPT_MAX_PAGE_BYTES,
  SUBAGENT_TRANSCRIPT_MAX_PAGE_ITEMS,
  SUBAGENT_TRANSCRIPT_RETAINED_PER_RUN,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration048 from "../Migrations/048_ProjectionSubagentTranscripts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionSubagentRunRepositoryLive } from "./ProjectionSubagentRuns.ts";
import { ProjectionSubagentTranscriptStoreLive } from "./ProjectionSubagentTranscripts.ts";
import {
  ProjectionSubagentRunRepository,
  type ProjectionSubagentRunRepositoryShape,
} from "../Services/ProjectionSubagentRuns.ts";
import {
  ProjectionSubagentTranscriptStore,
  type ProjectionSubagentTranscriptStoreShape,
  type ReadSubagentTranscriptPageResult,
} from "../Services/ProjectionSubagentTranscripts.ts";

// Apply 048 directly so this focused store test stays isolated from the full
// migration manifest.
const withMigration048 = Layer.effectDiscard(Migration048);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layer = it.layer(
  ProjectionSubagentTranscriptStoreLive.pipe(
    Layer.provideMerge(ProjectionSubagentRunRepositoryLive),
    Layer.provideMerge(withMigration048),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const RUN_BIRTH = "rbaaaaaaaaaaaaaaaaaaaaaa1";
const OTHER_RUN_BIRTH = "rbbbbbbbbbbbbbbbbbbbbbbb2";
const THREAD_ID = ThreadId.make("thread-transcript");
const MANAGER_ID = "manager-one";
const MANAGER_RUN_ID = "sa-1";
const ACTIVATION_ID = "act-1";
const at = (second: number) => `2026-06-15T00:00:${String(second).padStart(2, "0")}.000Z`;

const seedRun = (
  repository: ProjectionSubagentRunRepositoryShape,
  options?: {
    readonly runId?: string;
    readonly runBirth?: string | null;
    readonly historyAvailability?: "durable" | "summary-only" | "unavailable";
  },
) =>
  Effect.gen(function* () {
    const runId = RuntimeTaskId.make(options?.runId ?? "opaque-transcript-run");
    const runNumber = yield* repository.reserveRunNumber({
      runId,
      allocatedAt: at(0),
      ownerId: MANAGER_ID,
      ownerEpoch: "epoch-one",
      nativeRunId: MANAGER_RUN_ID,
      activationId: ACTIVATION_ID,
    });
    yield* repository.insertStart({
      runId,
      runNumber,
      threadId: THREAD_ID,
      parentRunId: null,
      runtimeFamily: "pi-manager",
      harness: "pi",
      provider: ProviderDriverKind.make("pi"),
      providerInstanceId: null,
      model: null,
      effort: null,
      title: null,
      summary: null,
      status: "active",
      terminalReason: null,
      controlAvailability: "owner-routed",
      historyAvailability: options?.historyAvailability ?? "durable",
      capabilities: { steer: true, cancel: true, resume: false },
      createdAt: at(0),
      updatedAt: at(0),
      terminalAt: null,
      runBirth: options?.runBirth === undefined ? RUN_BIRTH : options.runBirth,
      ownerId: null,
      ownerEpoch: "reserved",
      nativeRunId: null,
      activationId: null,
      firstEventSequence: 1,
      lastEventSequence: 1,
    });
    return runId;
  });

const item = (sequence: number, text = `item ${sequence}`) => ({
  kind: "assistant" as const,
  transcriptSequence: sequence,
  text,
  truncated: false,
  upstreamTruncated: false,
  createdAt: null as string | null,
});

const ingester =
  (
    store: ProjectionSubagentTranscriptStoreShape,
    runId: RuntimeTaskId,
    runBirth: string = RUN_BIRTH,
  ) =>
  (sequence: number, text?: string) =>
    store.ingestItem({
      runId,
      managerId: MANAGER_ID,
      managerRunId: MANAGER_RUN_ID,
      activationId: ACTIVATION_ID,
      runBirth,
      item: item(sequence, text),
      observedAt: at(1),
    });

const readPage = (
  store: ProjectionSubagentTranscriptStoreShape,
  runId: RuntimeTaskId,
  cursor?: { readonly afterSequence?: number; readonly beforeSequence?: number },
) => store.readPage({ threadId: THREAD_ID, runId, ...cursor });

const pageOf = (
  result:
    | ReadSubagentTranscriptPageResult
    | { readonly unavailable: "unknown-run" | "unavailable" },
): ReadSubagentTranscriptPageResult => {
  if ("unavailable" in result)
    throw new Error(`transcript page unavailable: ${result.unavailable}`);
  return result;
};

layer("ProjectionSubagentTranscriptStore", (it) => {
  it.effect("validates the binding tuple before any write", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const store = yield* ProjectionSubagentTranscriptStore;
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      assert.ok(!tables.some((table) => table.name === "subagent_transcript_gaps"));
      const runId = yield* seedRun(repository, { runId: "opaque-transcript-sanitize" });

      // Unknown opaque T3 run identity: rejected.
      const foreign = yield* store.ingestItem({
        runId: RuntimeTaskId.make("opaque-never-allocated"),
        managerId: MANAGER_ID,
        managerRunId: MANAGER_RUN_ID,
        activationId: ACTIVATION_ID,
        runBirth: RUN_BIRTH,
        item: item(1),
        observedAt: at(1),
      });
      assert.strictEqual(foreign.outcome, "rejected-binding");

      // Every producer/T3 tuple member is validated at the store boundary.
      const mismatchedManager = yield* store.ingestItem({
        runId,
        managerId: "other-manager",
        managerRunId: MANAGER_RUN_ID,
        activationId: ACTIVATION_ID,
        runBirth: RUN_BIRTH,
        item: item(1),
        observedAt: at(1),
      });
      assert.strictEqual(mismatchedManager.outcome, "rejected-binding");
      const mismatched = yield* ingester(store, runId, OTHER_RUN_BIRTH)(1);
      assert.strictEqual(mismatched.outcome, "rejected-binding");

      // Null run birth (capability-absent run): rejected.
      const plainRunId = yield* seedRun(repository, {
        runId: "opaque-plain-run",
        runBirth: null,
      });
      const plain = yield* ingester(store, plainRunId)(1);
      assert.strictEqual(plain.outcome, "rejected-binding");

      const page = pageOf(yield* readPage(store, runId));
      assert.deepStrictEqual(page.entries, []);
      assert.strictEqual(page.watermark, 0);
    }),
  );

  it.effect("sanitizes text, stores idempotently, and advances the watermark contiguously", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const store = yield* ProjectionSubagentTranscriptStore;
      const runId = yield* seedRun(repository, { runId: "opaque-transcript-cap-items" });
      const put = ingester(store, runId);

      const first = yield* put(1, "Authorization: Bearer super-secret-token-value");
      assert.strictEqual(first.outcome, "stored");
      assert.strictEqual(first.watermark, 1);

      const duplicate = yield* put(1, "different content, same sequence");
      assert.strictEqual(duplicate.outcome, "ignored-duplicate");
      assert.strictEqual(duplicate.watermark, 1);

      // A gap holds the watermark down.
      const gapped = yield* put(3, "item three");
      assert.strictEqual(gapped.outcome, "stored");
      assert.strictEqual(gapped.watermark, 1);
      assert.strictEqual(yield* store.getWatermark({ runId }), 1);
      const gappedPage = pageOf(yield* readPage(store, runId));
      assert.deepStrictEqual(gappedPage.entries[1], {
        kind: "gap",
        fromSequence: 2,
        toSequence: 2,
      });

      const filled = yield* put(2, "item two");
      assert.strictEqual(filled.outcome, "stored");
      assert.strictEqual(filled.watermark, 3);

      const page = pageOf(yield* readPage(store, runId));
      assert.strictEqual(page.entries.length, 3);
      const firstEntry = page.entries[0]!;
      assert.ok(firstEntry.kind === "assistant");
      assert.ok(firstEntry.text.includes("[REDACTED]"));
      assert.ok(!firstEntry.text.includes("super-secret-token-value"));
      assert.strictEqual(page.watermark, 3);
      assert.strictEqual(page.hasMore, false);

      // Keyset bound is exclusive.
      const tail = pageOf(yield* readPage(store, runId, { afterSequence: 2 }));
      assert.strictEqual(tail.entries.length, 1);
      assert.strictEqual(
        tail.entries[0]!.kind === "assistant" ? tail.entries[0]!.transcriptSequence : 0,
        3,
      );
    }),
  );

  it.effect("caps pages at 200 items and 256 KiB", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const store = yield* ProjectionSubagentTranscriptStore;
      const runId = yield* seedRun(repository, { runId: "opaque-transcript-evict" });
      const put = ingester(store, runId);
      for (let sequence = 1; sequence <= 205; sequence += 1) {
        yield* put(sequence);
      }
      const page = pageOf(yield* readPage(store, runId));
      assert.strictEqual(page.entries.length, SUBAGENT_TRANSCRIPT_MAX_PAGE_ITEMS);
      assert.strictEqual(page.hasMore, true);
      assert.strictEqual(
        page.entries[0]?.kind === "assistant" ? page.entries[0].transcriptSequence : 0,
        6,
      );
      const older = pageOf(yield* readPage(store, runId, { beforeSequence: 6 }));
      assert.strictEqual(older.entries.length, 5);
      assert.strictEqual(older.hasMore, false);

      // Payload cap: fields are capped at 4 096 code points at the T3
      // boundary, so 100 heavy items encode to well over 256 KiB — the page
      // must stop on payload, not on the 200-item bound.
      const heavyRunId = yield* seedRun(repository, { runId: "opaque-heavy-run" });
      const heavy = ingester(store, heavyRunId);
      for (let sequence = 1; sequence <= 100; sequence += 1) {
        yield* heavy(sequence, "🙂".repeat(9_000));
      }
      const heavyPage = pageOf(yield* readPage(store, heavyRunId));
      assert.ok(heavyPage.entries.length < 100);
      assert.ok(heavyPage.entries.length > 10);
      assert.ok(
        Buffer.byteLength(encodeUnknownJson(heavyPage), "utf8") <=
          SUBAGENT_TRANSCRIPT_MAX_PAGE_BYTES,
      );
      assert.strictEqual(heavyPage.hasMore, true);
    }),
  );

  it.effect(
    "evicts above the retention cap with durable non-bridging tombstones and drops replay inside them",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionSubagentRunRepository;
        const store = yield* ProjectionSubagentTranscriptStore;
        const sql = yield* SqlClient.SqlClient;
        const runId = yield* seedRun(repository, { runId: "opaque-transcript-late" });
        const put = ingester(store, runId);

        // 1..3 contiguous, then a never-observed gap at 4, then 5..504:
        // retention keeps the newest 500 and must tombstone 1..3 as one
        // inclusive range without bridging the gap at 4.
        for (let sequence = 1; sequence <= 3; sequence += 1) {
          yield* put(sequence);
        }
        for (let sequence = 5; sequence <= 504; sequence += 1) {
          yield* put(sequence);
        }

        const ranges = yield* sql<{ readonly fromSequence: number; readonly toSequence: number }>`
        SELECT from_sequence AS "fromSequence", to_sequence AS "toSequence"
        FROM subagent_transcript_evictions
        WHERE run_id = ${runId}
        ORDER BY from_sequence
      `;
        assert.deepStrictEqual(ranges, [{ fromSequence: 1, toSequence: 3 }]);

        const retained = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM subagent_transcript_items WHERE run_id = ${runId}
      `;
        assert.strictEqual(retained[0]!.count, SUBAGENT_TRANSCRIPT_RETAINED_PER_RUN);

        // Replay of a tombstoned sequence is dropped, never restored.
        const replayed = yield* put(2, "resurrected");
        assert.strictEqual(replayed.outcome, "dropped-evicted");

        // The never-observed gap at 4 still holds the watermark at 3, yet the
        // eviction marker renders distinctly from the gap marker.
        assert.strictEqual(yield* store.getWatermark({ runId }), 3);
        const page = pageOf(yield* readPage(store, runId, { beforeSequence: 5 }));
        const evictionMarker = page.entries[0]!;
        assert.strictEqual(evictionMarker.kind, "evicted");
        if (evictionMarker.kind === "evicted") {
          assert.strictEqual(evictionMarker.fromSequence, 1);
          assert.strictEqual(evictionMarker.toSequence, 3);
        }
        const gapMarker = page.entries[1]!;
        assert.strictEqual(gapMarker.kind, "gap");
        if (gapMarker.kind === "gap") {
          assert.strictEqual(gapMarker.fromSequence, 4);
          assert.strictEqual(gapMarker.toSequence, 4);
        }
      }),
  );

  it.effect("accepts late terminal items and keeps foreign or summary-only runs invisible", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const store = yield* ProjectionSubagentTranscriptStore;
      const runId = yield* seedRun(repository, { runId: "opaque-transcript-receipt-none" });
      yield* ingester(store, runId)(1);
      yield* repository.updateLifecycle({
        runId,
        status: "done",
        terminalReason: "native-completed",
        title: null,
        model: null,
        effort: null,
        summary: "finished",
        updatedAt: at(2),
        eventSequence: 9,
      });

      const late = yield* ingester(store, runId)(2, "late finalized item");
      assert.strictEqual(late.outcome, "stored");
      assert.strictEqual(late.watermark, 2);
      assert.strictEqual((yield* repository.getRunBinding({ runId }))?.lastTranscriptSequence, 2);
      // Lifecycle stays terminal and untouched by transcript acceptance.
      assert.strictEqual((yield* repository.getByRunId({ runId }))?.status, "done");

      // A run that does not exist in this state store is invisible: no content.
      const invisible = yield* store.readPage({
        threadId: THREAD_ID,
        runId: RuntimeTaskId.make("opaque-other-store"),
      });
      assert.deepStrictEqual(invisible, { unavailable: "unknown-run" });

      // A valid run requested through another thread is indistinguishable from unknown.
      const crossThread = yield* store.readPage({
        threadId: ThreadId.make("thread-other"),
        runId,
      });
      assert.deepStrictEqual(crossThread, { unavailable: "unknown-run" });

      // Summary-only runs never return content either.
      const summaryRunId = yield* seedRun(repository, {
        runId: "opaque-summary-run",
        historyAvailability: "summary-only",
      });
      const summaryPage = yield* readPage(store, summaryRunId);
      assert.deepStrictEqual(summaryPage, { unavailable: "unavailable" });
    }),
  );

  it.effect("reads bounded replay watermarks for tracked runs", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionSubagentRunRepository;
      const store = yield* ProjectionSubagentTranscriptStore;
      const runId = yield* seedRun(repository, { runId: "opaque-transcript-watermarks" });
      yield* ingester(store, runId)(1);
      yield* ingester(store, runId)(2);
      const emptyRunId = yield* seedRun(repository, { runId: "opaque-empty" });
      const watermarks = yield* store.readWatermarks([runId, emptyRunId]);
      assert.deepStrictEqual(watermarks, [
        { runId, watermark: 2 },
        { runId: emptyRunId, watermark: 0 },
      ]);
      const managerWatermarks = yield* store.readWatermarksForManager({
        threadId: THREAD_ID,
        managerId: MANAGER_ID,
      });
      assert.deepStrictEqual(managerWatermarks.slice(-2), [
        { runId, watermark: 2 },
        { runId: emptyRunId, watermark: 0 },
      ]);
      assert.ok(!managerWatermarks.some((entry) => entry.runId === "opaque-summary-run"));
    }),
  );
});

// Live-clock receipt semantics: the timeout bound needs real time, so this
// one test provides the store layer directly instead of the TestClock layer.
it.live("signals and awaits durable start receipts without polling", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionSubagentTranscriptStore;
    const runId = RuntimeTaskId.make("opaque-receipt-run");
    // A waiter that starts after the signal resolves immediately.
    yield* store.signalStartCommitted({ runId });
    assert.strictEqual(yield* store.awaitStartCommitted({ runId, timeoutMs: 1_000 }), true);
    // A run whose allocating row never commits resolves false at the bound.
    assert.strictEqual(
      yield* store.awaitStartCommitted({
        runId: RuntimeTaskId.make("opaque-never-committed"),
        timeoutMs: 20,
      }),
      false,
    );

    // Cache pressure may discard completed receipts, never a deferred with a
    // waiter that still needs the projector's signal.
    const pendingRunId = RuntimeTaskId.make("opaque-pending-receipt");
    const pending = yield* Effect.forkChild(
      store.awaitStartCommitted({ runId: pendingRunId, timeoutMs: 2_000 }),
    );
    yield* Effect.yieldNow;
    for (let index = 0; index < 1_024; index += 1) {
      yield* store.signalStartCommitted({
        runId: RuntimeTaskId.make(`opaque-completed-receipt-${index}`),
      });
    }
    yield* store.signalStartCommitted({ runId: pendingRunId });
    assert.strictEqual(yield* Fiber.join(pending), true);
  }).pipe(
    Effect.provide(
      ProjectionSubagentTranscriptStoreLive.pipe(
        Layer.provideMerge(ProjectionSubagentRunRepositoryLive),
        Layer.provideMerge(withMigration048),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);
