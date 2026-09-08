import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { NativeChildRunRepositoryLive } from "../Layers/NativeChildRuns.ts";
import { runMigrations } from "../Migrations.ts";
import {
  NativeChildDeliveryBatch,
  NativeChildRun,
  NativeChildRunRepository,
} from "../Services/NativeChildRuns.ts";

const timestamp = "2026-09-08T00:00:00.000Z";
const parentThreadId = ThreadId.make("delivery-parent");
const testLayer = NativeChildRunRepositoryLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);

it.layer(testLayer)("060_NativeChildDeliveryBatches", (it) => {
  it.effect("persists immutable batches and guards member settlement by the open batch", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* NativeChildRunRepository;
      const runId = RuntimeTaskId.make("delivery-run");
      const childThreadId = ThreadId.make("delivery-child");
      const runNumber = yield* repository.reserveRunNumber({
        runId,
        childThreadId,
        allocatedAt: timestamp,
      });
      yield* repository.insert(
        NativeChildRun.make({
          runId,
          agentId: runId,
          runNumber,
          parentRunId: null,
          parentThreadId,
          childThreadId,
          providerInstanceId: ProviderInstanceId.make("claude"),
          provider: ProviderDriverKind.make("claudeAgent"),
          model: "sonnet",
          title: "Delivery",
          runtimeMode: "approval-required",
          cwd: "/workspace",
          resumeCursor: null,
          generation: 1,
          status: "failed",
          output: "durable output",
          outputTruncated: false,
          error: "durable failure",
          deliveryState: "pending",
          deliveryAttempt: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );

      const first = NativeChildDeliveryBatch.make({
        batchId: "batch-first",
        parentThreadId,
        runtimeMode: "approval-required",
        text: "first immutable text",
        commandId: "command-first",
        messageId: "message-first",
        state: "prepared",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      expect(yield* repository.insertDeliveryBatch({ batch: first, runIds: [runId] })).toBe(true);
      expect(yield* repository.getOpenDeliveryBatch(parentThreadId)).toEqual({
        batch: first,
        runs: [expect.objectContaining({ runId, error: "durable failure" })],
      });
      expect(yield* repository.acknowledgeTerminal(runId)).toBe(false);
      yield* repository.markDeliveryBatchRejected({
        batchId: first.batchId,
        updatedAt: "2026-09-08T00:00:01.000Z",
      });
      expect((yield* repository.get(runId))?.deliveryAttempt).toBe(1);

      const second = NativeChildDeliveryBatch.make({
        ...first,
        batchId: "batch-second",
        text: "second immutable text",
        commandId: "command-second",
        messageId: "message-second",
        createdAt: "2026-09-08T00:00:02.000Z",
        updatedAt: "2026-09-08T00:00:02.000Z",
      });
      expect(yield* repository.insertDeliveryBatch({ batch: second, runIds: [runId] })).toBe(true);
      yield* repository.markDeliveryBatchDelivered({
        batchId: first.batchId,
        updatedAt: "2026-09-08T00:00:03.000Z",
      });
      expect((yield* repository.get(runId))?.deliveryState).toBe("pending");
      expect((yield* repository.getOpenDeliveryBatch(parentThreadId))?.batch).toEqual(second);

      yield* repository.markDeliveryBatchDelivered({
        batchId: second.batchId,
        updatedAt: "2026-09-08T00:00:04.000Z",
      });
      expect((yield* repository.get(runId))?.deliveryState).toBe("delivered");
      expect(yield* repository.getOpenDeliveryBatch(parentThreadId)).toBeNull();
    }),
  );
});
