import { assert, it, vi } from "@effect/vitest";
import {
  OrchestrationV2BackgroundTaskUnsupportedError,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { ProviderAdapterV2SessionRuntime } from "./ProviderAdapter.ts";
import * as ProviderBackgroundTaskService from "./ProviderBackgroundTaskService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const threadId = ThreadId.make("thread-background-task");
const providerSessionId = ProviderSessionId.make("session-background-task");
const providerThread = {
  id: ProviderThreadId.make("provider-thread-background-task"),
  providerSessionId,
  pendingBackgroundTasks: [{ taskId: "task-1", kind: "command" }],
} as unknown as OrchestrationV2ProviderThread;
const projection = {
  providerThreads: [providerThread],
  turnItems: [],
  runs: [],
} as unknown as OrchestrationV2ThreadProjection;

function testLayer(runtime: ProviderAdapterV2SessionRuntime) {
  return ProviderBackgroundTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () => Effect.succeed(Option.some(runtime)),
        }),
      ),
    ),
  );
}

function runtime(
  overrides: Partial<ProviderAdapterV2SessionRuntime>,
): ProviderAdapterV2SessionRuntime {
  const driver = ProviderDriverKind.make("codex");
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver,
    providerSessionId,
    providerSession: {
      capabilities: {
        backgroundWork: { canListTasks: true, stoppableTaskKinds: ["command"] },
      },
    } as unknown as ProviderAdapterV2SessionRuntime["providerSession"],
    ...overrides,
  } as ProviderAdapterV2SessionRuntime;
}

it.effect("stops the exact live background task through a supported adapter", () => {
  const stopBackgroundTask = vi.fn(
    (_input: { readonly providerThread: OrchestrationV2ProviderThread; readonly taskId: string }) =>
      Effect.void,
  );
  return Effect.gen(function* () {
    const service = yield* ProviderBackgroundTaskService.ProviderBackgroundTaskServiceV2;
    yield* service.stop({ threadId, taskId: "task-1" });
    assert.strictEqual(stopBackgroundTask.mock.calls.length, 1);
    assert.strictEqual(stopBackgroundTask.mock.calls[0]?.[0].taskId, "task-1");
    assert.strictEqual(stopBackgroundTask.mock.calls[0]?.[0].providerThread.id, providerThread.id);
  }).pipe(
    Effect.provide(
      testLayer(
        runtime({
          listBackgroundTasks: () =>
            Effect.succeed([{ taskId: "task-1", kind: "command" as const }]),
          stopBackgroundTask,
        }),
      ),
    ),
  );
});

it.effect("returns a typed unsupported error when the adapter cannot stop tasks", () =>
  Effect.gen(function* () {
    const service = yield* ProviderBackgroundTaskService.ProviderBackgroundTaskServiceV2;
    const error = yield* Effect.flip(service.stop({ threadId, taskId: "task-1" }));
    assert.instanceOf(error, OrchestrationV2BackgroundTaskUnsupportedError);
  }).pipe(Effect.provide(testLayer(runtime({})))),
);
