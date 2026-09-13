import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelections,
  RuntimeMode,
  RuntimeTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export const NativeChildRunStatus = Schema.Literals([
  "starting",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type NativeChildRunStatus = typeof NativeChildRunStatus.Type;

export const NATIVE_CHILD_RESTART_ERROR = "T3 Code restarted before the child turn completed.";

export const NativeChildRun = Schema.Struct({
  runId: RuntimeTaskId,
  agentId: RuntimeTaskId,
  runNumber: PositiveInt,
  parentRunId: Schema.NullOr(RuntimeTaskId),
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  requestedOptions: Schema.optional(ProviderOptionSelections),
  runtimeMode: RuntimeMode,
  cwd: TrimmedNonEmptyString,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  generation: PositiveInt,
  status: NativeChildRunStatus,
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  deliveryState: Schema.Literals(["pending", "suppressed", "delivered"]),
  deliveryAttempt: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NativeChildRun = typeof NativeChildRun.Type;

export const NativeChildDeliveryBatch = Schema.Struct({
  batchId: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  runtimeMode: RuntimeMode,
  text: TrimmedNonEmptyString,
  commandId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
  state: Schema.Literals(["prepared", "delivered", "rejected", "suppressed"]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NativeChildDeliveryBatch = typeof NativeChildDeliveryBatch.Type;

export interface NativeChildDeliveryBatchWithRuns {
  readonly batch: NativeChildDeliveryBatch;
  readonly runs: ReadonlyArray<NativeChildRun>;
}

export const NativeChildMessage = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  parentThreadId: ThreadId,
  senderAgentId: RuntimeTaskId,
  recipientAgentId: RuntimeTaskId,
  body: TrimmedNonEmptyString,
  deliveryState: Schema.Literals(["queued", "notified"]),
  deliveryRunId: Schema.NullOr(RuntimeTaskId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  acknowledgedAt: Schema.NullOr(IsoDateTime),
});
export type NativeChildMessage = typeof NativeChildMessage.Type;

export type NativeChildMessageInsertResult =
  | { readonly status: "inserted"; readonly message: NativeChildMessage }
  | { readonly status: "duplicate"; readonly message: NativeChildMessage }
  | { readonly status: "conflict" }
  | { readonly status: "inbox-full" };

type RepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface NativeChildParentWorkState {
  readonly active: number;
  readonly pendingDelivery: number;
}

export interface NativeChildRunRepositoryShape {
  readonly reserveRunNumber: (input: {
    readonly runId: RuntimeTaskId;
    readonly allocatedAt: string;
    readonly childThreadId: ThreadId;
  }) => Effect.Effect<number, RepositoryError>;
  readonly insert: (run: NativeChildRun) => Effect.Effect<void, RepositoryError>;
  readonly get: (runId: RuntimeTaskId) => Effect.Effect<NativeChildRun | null, RepositoryError>;
  readonly getByChildThread: (
    childThreadId: ThreadId,
  ) => Effect.Effect<NativeChildRun | null, RepositoryError>;
  readonly getLatestByAgent: (
    agentId: RuntimeTaskId,
  ) => Effect.Effect<NativeChildRun | null, RepositoryError>;
  readonly listLatestByParent: (
    parentThreadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<NativeChildRun>, RepositoryError>;
  readonly listActive: () => Effect.Effect<ReadonlyArray<NativeChildRun>, RepositoryError>;
  readonly getParentWorkState: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<NativeChildParentWorkState, RepositoryError>;
  readonly listPendingDelivery: (
    parentThreadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<NativeChildRun>, RepositoryError>;
  readonly getOpenDeliveryBatch: (
    parentThreadId: ThreadId,
  ) => Effect.Effect<NativeChildDeliveryBatchWithRuns | null, RepositoryError>;
  readonly insertDeliveryBatch: (input: {
    readonly batch: NativeChildDeliveryBatch;
    readonly runIds: ReadonlyArray<RuntimeTaskId>;
  }) => Effect.Effect<boolean, RepositoryError>;
  readonly markDeliveryBatchDelivered: (input: {
    readonly batchId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, RepositoryError>;
  readonly markDeliveryBatchRejected: (input: {
    readonly batchId: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, RepositoryError>;
  readonly acknowledgeTerminal: (runId: RuntimeTaskId) => Effect.Effect<boolean, RepositoryError>;
  readonly markRunning: (input: {
    readonly runId: RuntimeTaskId;
    readonly resumeCursor: unknown | null;
    readonly updatedAt: string;
  }) => Effect.Effect<void, RepositoryError>;
  readonly markTerminal: (input: {
    readonly runId: RuntimeTaskId;
    readonly status: "completed" | "failed" | "cancelled";
    readonly output: string;
    readonly outputTruncated: boolean;
    readonly error: string | null;
    readonly resumeCursor: unknown | null;
    readonly updatedAt: string;
  }) => Effect.Effect<void, RepositoryError>;
  readonly markDelivered: (runId: RuntimeTaskId) => Effect.Effect<void, RepositoryError>;
  readonly markParentDelivered: (parentThreadId: ThreadId) => Effect.Effect<void, RepositoryError>;
  readonly markDeliveryRetry: (runId: RuntimeTaskId) => Effect.Effect<void, RepositoryError>;
  readonly reconcileRestart: (
    interruptedAt: string,
  ) => Effect.Effect<ReadonlyArray<NativeChildRun>, RepositoryError>;
  readonly insertMessage: (
    message: NativeChildMessage,
  ) => Effect.Effect<NativeChildMessageInsertResult, RepositoryError>;
  readonly listPendingMessages: (
    recipientAgentId: RuntimeTaskId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<NativeChildMessage>, RepositoryError>;
  readonly acknowledgeMessage: (input: {
    readonly parentThreadId: ThreadId;
    readonly recipientAgentId: RuntimeTaskId;
    readonly messageId: string;
    readonly acknowledgedAt: string;
  }) => Effect.Effect<boolean, RepositoryError>;
  readonly markMessageNotified: (input: {
    readonly parentThreadId: ThreadId;
    readonly messageId: string;
    readonly deliveryRunId: RuntimeTaskId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, RepositoryError>;
}

export class NativeChildRunRepository extends Context.Service<
  NativeChildRunRepository,
  NativeChildRunRepositoryShape
>()("t3/persistence/Services/NativeChildRuns/NativeChildRunRepository") {}
