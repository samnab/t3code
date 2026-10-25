import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "../../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadHandlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:mcp-thread-controls");
const instanceId = ProviderInstanceId.make("codex");
// The effect worker is off, so runs are recorded but no provider session opens.
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("No provider session in MCP thread control tests"),
};

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
  { name: "mcp-thread-controls" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: layerDatabase, runEffectWorker: false },
);
const layerTest = McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ThreadManagement.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
        Layer.provideMerge(layerOrchestrator),
      ),
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "client:session-1",
        thread: undefined,
        client: { sessionId: "session-1", label: "Claude Code", access: "full-access" },
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
    ),
  ),
);

const last = <A, E, R, E2, R2>(
  handled: Effect.Effect<Stream.Stream<{ readonly result: A }, E, R>, E2, R2>,
) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((results) => results.at(-1)?.result),
  );

const createThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("mcp-thread-controls:create"),
    threadId,
    projectId: ProjectId.make("project:mcp-thread-controls"),
    title: "Thread controls",
    modelSelection: { instanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    goal: "First goal",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

const readThread = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return yield* projections.getThreadProjection(threadId);
});

it.effect("turns auto-settle off and on and reads it back", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    for (const [action, autoSettle] of [
      ["disable_auto_settle", false],
      ["enable_auto_settle", true],
    ] as const) {
      expect(
        yield* last(toolkit.handle("t3_thread_organize", { threadId, action })),
      ).toHaveProperty("sequence");
      expect(yield* last(toolkit.handle("t3_thread_configuration", { threadId }))).toMatchObject({
        autoSettle,
      });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("sets and clears a goal without starting work, only once its loop is paused", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    expect(yield* last(toolkit.handle("t3_thread_configuration", { threadId }))).toMatchObject({
      goal: "First goal",
      goalLoop: { state: "idle", iterations: 0 },
    });

    // An idle loop would be driven as soon as the goal changes.
    expect(
      yield* last(toolkit.handle("t3_thread_goal", { threadId, goal: "Second goal" })),
    ).toMatchObject({
      code: "invalid_request",
    });
    expect(
      yield* last(
        toolkit.handle("t3_thread_goal_loop", {
          threadId,
          action: "pause",
          expectedState: "running",
        }),
      ),
    ).toMatchObject({ code: "invalid_request", message: "The goal loop is idle, not running." });
    expect((yield* readThread).thread.goalLoop?.state).toBe("idle");

    yield* last(
      toolkit.handle("t3_thread_goal_loop", { threadId, action: "pause", expectedState: "idle" }),
    );
    expect(
      yield* last(toolkit.handle("t3_thread_goal", { threadId, goal: "Second goal" })),
    ).toHaveProperty("sequence");
    expect(yield* last(toolkit.handle("t3_thread_configuration", { threadId }))).toMatchObject({
      goal: "Second goal",
      goalLoop: { state: "paused" },
    });

    expect(yield* last(toolkit.handle("t3_thread_goal", { threadId, goal: null }))).toHaveProperty(
      "sequence",
    );
    const cleared = yield* readThread;
    expect(cleared.thread.goal).toBeNull();
    expect(cleared.thread.goalLoop).toBeNull();
    expect(cleared.runs).toHaveLength(0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses to start work that does not match the expected run", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    const runId = RunId.make("run:not-there");
    for (const action of ["retry_preparation", "start_queued", "resume_queue"] as const) {
      expect(
        yield* last(toolkit.handle("t3_run_start", { threadId, action, runId })),
      ).toMatchObject({
        code: expect.stringMatching(/^(invalid_request|orchestration_error)$/),
      });
    }
    expect((yield* readThread).runs).toHaveLength(0);
  }).pipe(Effect.provide(layerTest)),
);

const sendMessage = (
  id: string,
  dispatchMode: { readonly type: "start_immediately" | "queue_after_active" },
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`mcp-thread-controls:${id}`),
      threadId,
      messageId: MessageId.make(`message:${id}`),
      text: id,
      attachments: [],
      dispatchMode,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect.each(["resume_queue", "start_queued"] as const)(
  "%s starts held work only for the expected queued run",
  (action) =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* createThread;
      yield* sendMessage("first", { type: "start_immediately" });
      yield* sendMessage("second", { type: "queue_after_active" });
      const [active, queued] = (yield* readThread).runs.toSorted((a, b) => a.ordinal - b.ordinal);
      if (active === undefined || queued === undefined) return yield* Effect.die("runs missing");
      expect(queued.status).toBe("queued");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("mcp-thread-controls:stop"),
        threadId,
        runId: active.id,
        holdQueue: true,
      });
      expect((yield* readThread).runs.find((run) => run.id === queued.id)?.queueHeld).toBe(true);

      expect(
        yield* last(toolkit.handle("t3_run_start", { threadId, action, runId: active.id })),
      ).toMatchObject({
        code: action === "resume_queue" ? "invalid_request" : "orchestration_error",
      });
      expect((yield* readThread).runs.find((run) => run.id === queued.id)?.queueHeld).toBe(true);
      expect(
        yield* last(toolkit.handle("t3_run_start", { threadId, action, runId: queued.id })),
      ).toHaveProperty("sequence");
      expect((yield* readThread).runs.find((run) => run.id === queued.id)?.queueHeld).toBe(false);
    }).pipe(Effect.provide(layerTest)),
);
