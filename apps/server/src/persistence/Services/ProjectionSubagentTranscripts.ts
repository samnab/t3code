import {
  NonNegativeInt,
  PositiveInt,
  RuntimeTaskId,
  SubagentTranscriptItemKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

/** Input item exactly as the enhanced manager emitted it (pre-sanitization). */
export const IngestSubagentTranscriptItemInput = Schema.Struct({
  runId: RuntimeTaskId,
  /** Binding evidence carried by the record; validated against the durable row. */
  runBirth: Schema.String,
  item: Schema.Struct({
    kind: SubagentTranscriptItemKind,
    transcriptSequence: PositiveInt,
    text: Schema.String,
    truncated: Schema.Boolean,
    upstreamTruncated: Schema.Boolean,
    createdAt: Schema.NullOr(Schema.String),
  }),
  observedAt: Schema.String,
});
export type IngestSubagentTranscriptItemInput = typeof IngestSubagentTranscriptItemInput.Type;

export type IngestSubagentTranscriptOutcome =
  | "stored"
  /** A duplicate sequence arrived; insert-or-ignore kept the original row. */
  | "ignored-duplicate"
  /** The sequence sits inside a durable eviction range; replay must not restore it. */
  | "dropped-evicted"
  /** The five-member binding tuple failed; the record is rejected. */
  | "rejected-binding";

export interface IngestSubagentTranscriptResult {
  readonly outcome: IngestSubagentTranscriptOutcome;
  /** Highest contiguously observed finalized sequence after this ingest. */
  readonly watermark: number;
}

export const ReadSubagentTranscriptPageInput = Schema.Struct({
  runId: RuntimeTaskId,
  afterSequence: Schema.optionalKey(NonNegativeInt),
});
export type ReadSubagentTranscriptPageInput = typeof ReadSubagentTranscriptPageInput.Type;

export interface ReadSubagentTranscriptPageResult {
  readonly entries: ReadonlyArray<
    | {
        readonly kind: "user" | "assistant" | "toolResult";
        readonly transcriptSequence: number;
        readonly text: string;
        readonly truncated: boolean;
        readonly upstreamTruncated: boolean;
        readonly createdAt: string | null;
      }
    | {
        readonly kind: "evicted" | "gap";
        readonly fromSequence: number;
        readonly toSequence: number;
      }
  >;
  readonly watermark: number;
  readonly hasMore: boolean;
}

export const GetSubagentTranscriptWatermarkInput = Schema.Struct({ runId: RuntimeTaskId });
export type GetSubagentTranscriptWatermarkInput = typeof GetSubagentTranscriptWatermarkInput.Type;

export interface ProjectionSubagentTranscriptStoreShape {
  /**
   * Durable-start receipt: the projector calls this once the allocating run
   * row is committed, which is the precondition for routing a
   * `run-upsert-result` back to the manager.
   */
  readonly signalStartCommitted: (
    input: GetSubagentTranscriptWatermarkInput,
  ) => Effect.Effect<void>;
  /**
   * Await the durable start receipt for one allocating run. Resolves false
   * when the receipt does not land within the bound (allocation presumed
   * failed); never polls.
   */
  readonly awaitStartCommitted: (input: {
    readonly runId: RuntimeTaskId;
    readonly timeoutMs: number;
  }) => Effect.Effect<boolean>;
  /** Sanitize, bind-validate, insert-or-ignore, evict, and advance the watermark. */
  readonly ingestItem: (
    input: IngestSubagentTranscriptItemInput,
  ) => Effect.Effect<IngestSubagentTranscriptResult, ProjectionRepositoryError>;
  /** Durable per-run replay watermark (0 when nothing was observed). */
  readonly getWatermark: (
    input: GetSubagentTranscriptWatermarkInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  /** Bounded open-run watermarks for the reconnect replay envelope. */
  readonly readWatermarks: (
    runIds: ReadonlyArray<RuntimeTaskId>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly runId: RuntimeTaskId; readonly watermark: number }>,
    ProjectionRepositoryError
  >;
  /**
   * Authorized keyset read. Cross-thread and cross-environment runs are
   * invisible: the run row must exist in this state store, and only
   * `durable`-history runs ever return content.
   */
  readonly readPage: (
    input: ReadSubagentTranscriptPageInput,
  ) => Effect.Effect<
    ReadSubagentTranscriptPageResult | { readonly unavailable: "unknown-run" | "unavailable" },
    ProjectionRepositoryError
  >;
}

/**
 * Side store for Phase 1.5 enhanced-manager child transcripts. One shared
 * instance per server: the in-memory durable-start receipts rendezvous the
 * projector (signaler) with runtime ingestion (waiter), so composition must
 * provide this layer once at a shared level.
 */
export class ProjectionSubagentTranscriptStore extends Context.Service<
  ProjectionSubagentTranscriptStore,
  ProjectionSubagentTranscriptStoreShape
>()("t3/persistence/Services/ProjectionSubagentTranscripts/ProjectionSubagentTranscriptStore") {}
