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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
const invocationScope = (access: "full-access" | "read-only") => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
});

const handlersOverDatabase = Layer.mergeAll(
  ThreadManagement.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
    Layer.provideMerge(layerOrchestrator),
  ),
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  NodeCrypto.layer,
  // Merged so the regression can seed runs the way completed runs persist.
  layerDatabase,
);
const layerTest = McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
  Layer.provideMerge(handlersOverDatabase),
  Layer.provideMerge(
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope("full-access")),
  ),
);
const layerReadOnly = McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(
  Layer.provideMerge(handlersOverDatabase),
  Layer.provideMerge(
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocationScope("read-only")),
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

// Mark-unread rewinds to a completed run, so the regression seeds one straight
// into the projection store the way a finished provider run would leave it.
const insertCompletedRun = (ordinal: number, completedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runId = `run:api13-read-receipts-${ordinal}`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
        status, requested_at, completed_at, payload_json
      )
      VALUES (
        ${runId}, ${threadId}, ${ordinal}, ${instanceId}, ${instanceId}, NULL,
        'completed', ${completedAt}, ${completedAt}, ${JSON.stringify({
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "gpt-5" },
          providerThreadId: null,
          userMessageId: `message:api13-read-receipts-${ordinal}`,
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: completedAt,
          startedAt: null,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        })}
      )
    `;
  });

const readState = Effect.gen(function* () {
  const { thread, runs } = yield* readThread;
  const latestRunCompletedAt = runs.at(-1)?.completedAt ?? null;
  return {
    lastVisitedAt: thread.lastVisitedAt === null ? null : DateTime.formatIso(thread.lastVisitedAt),
    updatedAt: DateTime.formatIso(thread.updatedAt),
    latestRunCompletedAt:
      latestRunCompletedAt === null ? null : DateTime.formatIso(latestRunCompletedAt),
  };
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

it.effect("sets and clears a goal with its loop paused, starting no work", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    expect(
      yield* last(toolkit.handle("t3_thread_goal", { threadId, goal: "First goal" })),
    ).toHaveProperty("sequence");
    expect(yield* last(toolkit.handle("t3_thread_configuration", { threadId }))).toMatchObject({
      goal: "First goal",
      goalLoop: { state: "paused", iterations: 0 },
    });

    expect(
      yield* last(
        toolkit.handle("t3_thread_goal_loop", {
          threadId,
          action: "resume",
          expectedState: "running",
        }),
      ),
    ).toMatchObject({ code: "invalid_request", message: "The goal loop is paused, not running." });
    expect((yield* readThread).thread.goalLoop?.state).toBe("paused");

    yield* last(
      toolkit.handle("t3_thread_goal_loop", {
        threadId,
        action: "resume",
        expectedState: "paused",
      }),
    );
    expect((yield* readThread).thread.goalLoop?.state).toBe("idle");
    // Changing the goal of a loop that is due to run pauses it again.
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

it.effect(
  "mark_read records a read receipt at the observed version and reads never advance it",
  () =>
    Effect.gen(function* () {
      const toolkit = yield* ThreadToolkit;
      yield* TestClock.adjust("2 hours");
      yield* createThread;
      yield* insertCompletedRun(1, "1970-01-01T01:00:00.000Z");
      expect(yield* readState).toEqual({
        lastVisitedAt: null,
        updatedAt: "1970-01-01T02:00:00.000Z",
        latestRunCompletedAt: "1970-01-01T01:00:00.000Z",
      });
      // The test clock moves an hour past the thread's last edit: a receipt
      // stamped from the handler's own clock would land at 03:00, not 02:00.
      yield* TestClock.adjust("1 hour");

      expect(
        yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_unread" })),
      ).toHaveProperty("sequence");
      expect(yield* readState).toMatchObject({ lastVisitedAt: "1970-01-01T00:59:59.999Z" });

      expect(
        yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" })),
      ).toHaveProperty("sequence");
      expect(yield* readState).toEqual({
        lastVisitedAt: "1970-01-01T02:00:00.000Z",
        updatedAt: "1970-01-01T02:00:00.000Z",
        latestRunCompletedAt: "1970-01-01T01:00:00.000Z",
      });

      // Reading again changes nothing: no watermark movement and no settlement,
      // snooze, pin, goal, queue, open-count or search-stat edits.
      const settled = yield* readThread;
      yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" }));
      expect(yield* readThread).toEqual(settled);

      // A completion newer than the captured version stays unread, and the next
      // mark_unread rewinds to it instead of the stale receipt.
      yield* insertCompletedRun(2, "1970-01-01T04:00:00.000Z");
      expect(yield* readState).toEqual({
        lastVisitedAt: "1970-01-01T02:00:00.000Z",
        updatedAt: "1970-01-01T02:00:00.000Z",
        latestRunCompletedAt: "1970-01-01T04:00:00.000Z",
      });
      yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_unread" }));
      expect(yield* readState).toMatchObject({ lastVisitedAt: "1970-01-01T03:59:59.999Z" });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("denies a read-only client's mark_read and records nothing", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    const before = yield* readThread;
    expect(
      yield* last(toolkit.handle("t3_thread_organize", { threadId, action: "mark_read" })),
    ).toMatchObject({ code: "capability_denied" });
    expect(yield* readThread).toEqual(before);
  }).pipe(Effect.provide(layerReadOnly)),
);

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

it.effect("lowers a thread's modes and refuses to raise them, recording nothing", () =>
  Effect.gen(function* () {
    const toolkit = yield* ThreadToolkit;
    yield* createThread;
    expect(
      yield* last(toolkit.handle("t3_thread_lower_modes", { threadId, runtimeMode: "auto" })),
    ).toHaveProperty("sequence");
    expect(
      yield* last(toolkit.handle("t3_thread_lower_modes", { threadId, interactionMode: "plan" })),
    ).toHaveProperty("sequence");
    const lowered = (yield* readThread).thread;
    expect(lowered).toMatchObject({ runtimeMode: "auto", interactionMode: "plan" });

    const message = "Agents can only lower a thread's modes; raise them in the app.";
    expect(
      yield* last(
        toolkit.handle("t3_thread_lower_modes", { threadId, runtimeMode: "full-access" }),
      ),
    ).toMatchObject({ code: "runtime_mode_escalation_denied", message });
    expect(
      yield* last(
        toolkit.handle("t3_thread_lower_modes", { threadId, interactionMode: "default" }),
      ),
    ).toMatchObject({ code: "interaction_mode_escalation_denied", message });
    expect((yield* readThread).thread).toEqual(lowered);
  }).pipe(Effect.provide(layerTest)),
);
