import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProviderDriverKind,
  ProviderInstanceId,
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

export const NativeChildRun = Schema.Struct({
  runId: RuntimeTaskId,
  runNumber: PositiveInt,
  parentRunId: Schema.NullOr(RuntimeTaskId),
  parentThreadId: ThreadId,
  childThreadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  cwd: TrimmedNonEmptyString,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  generation: PositiveInt,
  status: NativeChildRunStatus,
  output: Schema.String,
  outputTruncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  deliveryState: Schema.Literals(["pending", "delivering", "delivered"]),
  deliveryAttempt: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type NativeChildRun = typeof NativeChildRun.Type;

type RepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface NativeChildRunRepositoryShape {
  readonly reserveRunNumber: (input: {
    readonly runId: RuntimeTaskId;
    readonly allocatedAt: string;
    readonly childThreadId: ThreadId;
  }) => Effect.Effect<number, RepositoryError>;
  readonly insert: (run: NativeChildRun) => Effect.Effect<void, RepositoryError>;
  readonly get: (runId: RuntimeTaskId) => Effect.Effect<NativeChildRun | null, RepositoryError>;
  readonly listActive: () => Effect.Effect<ReadonlyArray<NativeChildRun>, RepositoryError>;
  readonly listPendingDelivery: (
    parentThreadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<NativeChildRun>, RepositoryError>;
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
  readonly markDeliveryRetry: (runId: RuntimeTaskId) => Effect.Effect<void, RepositoryError>;
  readonly reconcileRestart: (
    interruptedAt: string,
  ) => Effect.Effect<ReadonlyArray<NativeChildRun>, RepositoryError>;
}

export class NativeChildRunRepository extends Context.Service<
  NativeChildRunRepository,
  NativeChildRunRepositoryShape
>()("t3/persistence/Services/NativeChildRuns/NativeChildRunRepository") {}
