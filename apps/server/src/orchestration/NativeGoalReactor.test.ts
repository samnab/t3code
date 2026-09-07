import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ProviderExecutionGoalSetInput,
  type ProviderExecutionGoalStatus,
  type ProviderRuntimeEvent,
  type ThreadGoalLoop,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ProviderSessionNotFoundError, ProviderValidationError } from "../provider/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as NativeGoalReactor from "./NativeGoalReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const NOW = "2026-09-04T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("native-goal-project");
const THREAD_ID = ThreadId.make("native-goal-thread");

function makeLoop(overrides: Partial<ThreadGoalLoop> = {}): ThreadGoalLoop {
  return {
    kind: "standard",
    state: "idle",
    mode: "native",
    iterations: 0,
    maxIterations: 10,
    reason: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSession(providerName = "codex"): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status: "idle",
    providerName,
    providerInstanceId: ProviderInstanceId.make(providerName),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function makeShell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Native goal thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    voiceNotifications: true,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    goal: "Ship the login fix",
    goalLoop: makeLoop(),
    session: makeSession(),
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeMetaUpdatedEvent(): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make("event-meta-updated"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.meta-updated",
    payload: { threadId: THREAD_ID, updatedAt: NOW },
  };
}

function makeCodexGoalEvent(status: ProviderExecutionGoalStatus | null): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(`event-codex-goal:${status ?? "cleared"}`),
    provider: ProviderDriverKind.make("codex"),
    threadId: THREAD_ID,
    createdAt: NOW,
    type: "thread.goal.updated",
    payload: { status },
  };
}

interface HarnessOptions {
  readonly shell: OrchestrationThreadShell;
  /** Fails every set/clear with this error instead of succeeding. */
  readonly providerFailure?: ProviderValidationError | ProviderSessionNotFoundError;
}

const makeHarness = Effect.fn("makeNativeGoalHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const shell = yield* Ref.make(options.shell);
  const shellReads = yield* Queue.unbounded<ThreadId>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const goalCalls = yield* Ref.make<ReadonlyArray<ProviderExecutionGoalSetInput | "clear">>([]);
  const events = yield* Queue.unbounded<OrchestrationEvent>();
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));

  const record = (call: ProviderExecutionGoalSetInput | "clear") =>
    Ref.update(goalCalls, (recorded) => [...recorded, call]).pipe(
      Effect.andThen(options.providerFailure ? Effect.fail(options.providerFailure) : Effect.void),
    );

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Queue.offer(shellReads, threadId).pipe(
          Effect.andThen(Ref.get(shell)),
          Effect.map((current) => (current.id === threadId ? Option.some(current) : Option.none())),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ProviderService)({
      setExecutionGoal: (input) =>
        record(input).pipe(
          Effect.as({
            goal: {
              threadId: input.threadId,
              objective: input.objective ?? "Ship the login fix",
              status: input.status ?? ("active" as const),
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
          }),
        ),
      clearExecutionGoal: () => record("clear"),
      streamEvents: Stream.fromQueue(runtimeEvents),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );

  return {
    activation,
    shell,
    shellReads,
    commands,
    goalCalls,
    events,
    runtimeEvents,
    layer: NativeGoalReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

/**
 * Starts the reactor, then feeds one signal and waits for its shell read plus
 * a worker drain. Every signal reads the shell exactly once, so the read queue
 * is the reactor's own progress marker — no sleeps, no polling.
 */
const runSignal = Effect.fn("runNativeGoalSignal")(function* (input: {
  readonly reactor: NativeGoalReactor.NativeGoalReactor["Service"];
  readonly activation: Deferred.Deferred<void>;
  readonly shellReads: Queue.Queue<ThreadId>;
  readonly offer: Effect.Effect<unknown>;
}) {
  yield* input.reactor.start();
  yield* Deferred.succeed(input.activation, undefined);
  yield* input.offer;
  yield* Queue.take(input.shellReads);
  yield* input.reactor.drain;
});

describe("mirrorState", () => {
  it("maps every Codex status onto a loop state", () => {
    assert.deepEqual(NativeGoalReactor.mirrorState("active"), { state: "running" });
    assert.deepEqual(NativeGoalReactor.mirrorState("paused"), { state: "paused" });
    assert.deepEqual(NativeGoalReactor.mirrorState("complete"), { state: "completed" });
    assert.deepEqual(NativeGoalReactor.mirrorState(null), {
      state: "blocked",
      reason: NativeGoalReactor.CODEX_CLEARED_REASON,
    });
    assert.strictEqual(NativeGoalReactor.mirrorState("usageLimited").state, "blocked");
  });
});

describe("desiredCodexGoal", () => {
  it("leaves Codex alone in the states Codex itself reported", () => {
    assert.strictEqual(NativeGoalReactor.desiredCodexGoal("ship", "completed"), undefined);
    assert.strictEqual(NativeGoalReactor.desiredCodexGoal("ship", "blocked"), undefined);
    assert.deepEqual(NativeGoalReactor.desiredCodexGoal("ship", "idle"), {
      objective: "ship",
      status: "active",
    });
    assert.deepEqual(NativeGoalReactor.desiredCodexGoal("ship", "paused"), {
      objective: "ship",
      status: "paused",
    });
    assert.strictEqual(NativeGoalReactor.desiredCodexGoal(null, "idle"), null);
  });
});

describe("NativeGoalReactor", () => {
  const run = Effect.fn("nativeGoalRun")(function* (
    options: HarnessOptions & {
      readonly signal: (fixture: {
        readonly events: Queue.Queue<OrchestrationEvent>;
        readonly runtimeEvents: Queue.Queue<ProviderRuntimeEvent>;
      }) => Effect.Effect<unknown>;
    },
  ) {
    const fixture = yield* makeHarness(options);
    return yield* Effect.gen(function* () {
      const reactor = yield* NativeGoalReactor.NativeGoalReactor;
      yield* runSignal({
        reactor,
        activation: fixture.activation,
        shellReads: fixture.shellReads,
        offer: options.signal(fixture),
      });
      return {
        commands: yield* Ref.get(fixture.commands),
        goalCalls: yield* Ref.get(fixture.goalCalls),
      };
    }).pipe(Effect.provide(fixture.layer));
  });

  const goalChanged = (fixture: { readonly events: Queue.Queue<OrchestrationEvent> }) =>
    Queue.offer(fixture.events, makeMetaUpdatedEvent());

  it.effect("sets the Codex execution goal to the T3 goal text", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { goalCalls } = yield* run({ shell: makeShell(), signal: goalChanged });
        assert.deepEqual(goalCalls, [
          { threadId: THREAD_ID, objective: "Ship the login fix", status: "active" },
        ]);
      }),
    ),
  );

  it.effect("clears the Codex execution goal when the T3 goal is cleared", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { goalCalls } = yield* run({
          shell: makeShell({ goal: null }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, ["clear"]);
      }),
    ),
  );

  it.effect("sends paused when the user paused the T3 loop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { goalCalls } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ state: "paused" }) }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, [
          { threadId: THREAD_ID, objective: "Ship the login fix", status: "paused" },
        ]);
      }),
    ),
  );

  it.effect("touches nothing on a thread whose real driver is not Codex", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { goalCalls } = yield* run({
          shell: makeShell({ session: makeSession("claudeAgent") }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, []);
      }),
    ),
  );

  it.effect("corrects a mode the decider guessed from a custom instance id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A custom Codex instance id reads as `t3` to the decider; the bound
        // session's driver is the truth.
        const { commands, goalCalls } = yield* run({
          shell: makeShell({
            modelSelection: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5" },
            goalLoop: makeLoop({ mode: "t3" }),
          }),
          signal: goalChanged,
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop" || command.action !== "sync") return;
        assert.strictEqual(command.action, "sync");
        assert.strictEqual(command.mode, "native");
        // The corrected mode is native, so the push runs in the same pass.
        assert.strictEqual(goalCalls.length, 1);
      }),
    ),
  );

  it.effect("waits for a live session instead of reporting a failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ session: null }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, []);
        assert.deepEqual(commands, []);
      }),
    ),
  );

  it.effect("surfaces a failed Codex clear as a thread activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands } = yield* run({
          shell: makeShell({ goal: null }),
          providerFailure: new ProviderValidationError({
            operation: "ProviderService.clearExecutionGoal",
            issue: "Method not found",
          }),
          signal: goalChanged,
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.activity.append");
        if (command.type !== "thread.activity.append") return;
        assert.strictEqual(command.activity.kind, "goal.native.failed");
        assert.strictEqual(command.activity.tone, "error");
        assert.strictEqual(command.activity.summary, "Could not clear the Codex execution goal");
      }),
    ),
  );

  it.effect("mirrors a Codex clear onto the loop as blocked", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ state: "running" }) }),
          signal: (fixture) => Queue.offer(fixture.runtimeEvents, makeCodexGoalEvent(null)),
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop" || command.action !== "sync") return;
        assert.strictEqual(command.action, "sync");
        assert.strictEqual(command.state, "blocked");
        assert.strictEqual(command.reason, NativeGoalReactor.CODEX_CLEARED_REASON);
      }),
    ),
  );

  it.effect("mirrors a Codex pause without resuming it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ state: "running" }) }),
          signal: (fixture) => Queue.offer(fixture.runtimeEvents, makeCodexGoalEvent("paused")),
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop" || command.action !== "sync") return;
        assert.strictEqual(command.state, "paused");
        // Mirroring is read-only: nothing goes back to Codex.
        assert.deepEqual(goalCalls, []);
      }),
    ),
  );

  it.effect("stays quiet when Codex reports the state the loop already holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ state: "paused" }) }),
          signal: (fixture) => Queue.offer(fixture.runtimeEvents, makeCodexGoalEvent("paused")),
        });
        assert.deepEqual(commands, []);
      }),
    ),
  );
});
