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

import {
  ProviderAdapterSessionNotFoundError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../provider/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
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
    experiment: null,
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
    pullRequests: [],
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

function makeGoalLoopUpdatedEvent(
  state: ThreadGoalLoop["state"],
  resumed = false,
): OrchestrationEvent {
  return {
    sequence: 2,
    eventId: EventId.make(`event-goal-loop:${state}:${resumed ? "resumed" : "sync"}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.goal-loop-updated",
    payload: {
      threadId: THREAD_ID,
      loop: makeLoop({ state }),
      ...(resumed ? { resumed: true } : {}),
    },
  };
}

function makeGoalActivatedEvent(): OrchestrationEvent {
  return makeGoalLoopUpdatedEvent("idle", true);
}

function makeGoalClearedEvent(): OrchestrationEvent {
  return {
    sequence: 2,
    eventId: EventId.make("event-goal-loop-cleared"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.goal-loop-updated",
    payload: { threadId: THREAD_ID, loop: null },
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
  readonly sweepThreads?: ReadonlyArray<OrchestrationThreadShell>;
  /** Fails every set/clear with this error instead of succeeding. */
  readonly providerFailure?: ProviderValidationError | ProviderSessionNotFoundError;
  readonly providerFailures?: ReadonlyArray<ProviderAdapterSessionNotFoundError>;
  readonly nativeGoalPresent?: boolean;
  readonly providerBindingPresent?: boolean;
}

const makeHarness = Effect.fn("makeNativeGoalHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const shell = yield* Ref.make(options.shell);
  const shellReads = yield* Queue.unbounded<ThreadId>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const goalCalls = yield* Ref.make<ReadonlyArray<ProviderExecutionGoalSetInput | "clear">>([]);
  const events = yield* Queue.unbounded<OrchestrationEvent>();
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const providerFailures = [...(options.providerFailures ?? [])];

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));

  const record = (call: ProviderExecutionGoalSetInput | "clear") => {
    const failure = providerFailures.shift() ?? options.providerFailure;
    return Ref.update(goalCalls, (recorded) => [...recorded, call]).pipe(
      Effect.andThen(failure ? Effect.fail(failure) : Effect.void),
    );
  };

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [],
          threads: options.sweepThreads ?? [],
          updatedAt: NOW,
        }),
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
      subscribeDomainEvents: Effect.succeed(Stream.fromQueue(events)),
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ProviderService)({
      getExecutionGoal: () =>
        Effect.succeed({
          goal:
            options.nativeGoalPresent === false
              ? null
              : {
                  threadId: THREAD_ID,
                  objective: "Ship the login fix",
                  status: "active" as const,
                  tokensUsed: 0,
                  timeUsedSeconds: 0,
                  createdAt: NOW,
                  updatedAt: NOW,
                },
        }),
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
    Layer.mock(ProviderSessionDirectory)({
      getBinding: () =>
        Effect.succeed(
          options.providerBindingPresent === false
            ? Option.none()
            : Option.some({
                threadId: THREAD_ID,
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
              }),
        ),
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

  it.effect("deactivates Codex before migrating a standard goal to T3", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({ shell: makeShell(), signal: goalChanged });
        assert.deepEqual(goalCalls, ["clear"]);
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop" || command.action !== "sync") return;
        assert.strictEqual(command.mode, "t3");
      }),
    ),
  );

  it.effect("migrates a persisted standard Codex goal during the startup sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shell = makeShell();
        const fixture = yield* makeHarness({ shell, sweepThreads: [shell] });
        yield* Effect.gen(function* () {
          const reactor = yield* NativeGoalReactor.NativeGoalReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          assert.deepEqual(yield* Ref.get(fixture.goalCalls), ["clear"]);
          const commands = yield* Ref.get(fixture.commands);
          assert.strictEqual(commands.length, 1);
          const command = commands[0]!;
          assert.strictEqual(command.type, "thread.goal.loop");
          if (command.type !== "thread.goal.loop" || command.action !== "sync") return;
          assert.strictEqual(command.mode, "t3");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("does not start a native bootstrap when a standard goal is activated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell(),
          signal: (fixture) => Queue.offer(fixture.events, makeGoalActivatedEvent()),
        });
        assert.deepEqual(goalCalls, ["clear"]);
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
      }),
    ),
  );

  it.effect("defers deactivation until a fresh Codex thread has a provider binding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({
            goalLoop: makeLoop({ mode: "t3" }),
            session: { ...makeSession(), status: "starting" },
          }),
          providerBindingPresent: false,
          providerFailure: new ProviderValidationError({
            operation: "ProviderService.clearExecutionGoal",
            issue: `Cannot route thread '${THREAD_ID}' because no persisted provider binding exists.`,
          }),
          signal: (fixture) => Queue.offer(fixture.events, makeGoalActivatedEvent()),
        });
        assert.deepEqual(goalCalls, []);
        assert.deepEqual(commands, []);
      }),
    ),
  );

  it.effect("migrates a standard goal while its existing turn finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ session: { ...makeSession(), status: "running" } }),
          signal: (fixture) => Queue.offer(fixture.events, makeGoalActivatedEvent()),
        });
        assert.deepEqual(goalCalls, ["clear"]);
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0]?.type, "thread.goal.loop");
      }),
    ),
  );

  it.effect("sets the Codex execution goal for a restricted experiment loop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { goalCalls } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ kind: "experiment" }) }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, [
          { threadId: THREAD_ID, objective: "Ship the login fix", status: "active" },
        ]);
      }),
    ),
  );

  it.effect("guards a restricted experiment bootstrap by its goal generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ kind: "experiment", state: "idle" }) }),
          signal: (fixture) => Queue.offer(fixture.events, makeGoalActivatedEvent()),
        });
        assert.strictEqual(goalCalls.length, 1);
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.turn.start");
        if (command.type !== "thread.turn.start") return;
        assert.strictEqual(command.onlyIfIdle, true);
        assert.deepEqual(command.goalLoopGuard, { updatedAt: NOW });
      }),
    ),
  );

  it.effect("retries after the session projection arrives before adapter registration", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          shell: makeShell({ goalLoop: makeLoop({ kind: "experiment" }) }),
          providerFailures: [
            new ProviderAdapterSessionNotFoundError({
              provider: ProviderDriverKind.make("codex"),
              threadId: THREAD_ID,
            }),
          ],
        });
        yield* Effect.gen(function* () {
          const reactor = yield* NativeGoalReactor.NativeGoalReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);

          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;
          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          assert.strictEqual((yield* Ref.get(fixture.goalCalls)).length, 2);
          assert.deepEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect(
    "leaves the separate Codex execution-goal escape hatch alone without a thread goal",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { commands, goalCalls } = yield* run({
            shell: makeShell({ goal: null }),
            signal: goalChanged,
          });
          assert.deepEqual(goalCalls, []);
          assert.deepEqual(commands, []);
        }),
      ),
  );

  it.effect("clears a native goal previously managed by the T3 thread goal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          shell: makeShell({ goalLoop: makeLoop({ kind: "experiment" }) }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* NativeGoalReactor.NativeGoalReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);

          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;
          yield* Ref.set(fixture.shell, makeShell({ goal: null, goalLoop: null }));
          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          assert.deepEqual(yield* Ref.get(fixture.goalCalls), [
            { threadId: THREAD_ID, objective: "Ship the login fix", status: "active" },
            "clear",
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("preserves a paused standard state while taking ownership", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ state: "paused" }) }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, ["clear"]);
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop" || command.action !== "sync") return;
        assert.strictEqual(command.mode, "t3");
        assert.strictEqual(command.state, undefined);
      }),
    ),
  );

  it.effect("leaves a legacy native loop in charge when deactivation fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell(),
          providerFailure: new ProviderValidationError({
            operation: "ProviderService.clearExecutionGoal",
            issue: "Method not found",
          }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, ["clear"]);
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0]?.type, "thread.activity.append");
      }),
    ),
  );

  it.effect("blocks future T3 scheduling when deactivation fails after takeover", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ mode: "t3", state: "running" }) }),
          providerFailure: new ProviderValidationError({
            operation: "ProviderService.clearExecutionGoal",
            issue: "Method not found",
          }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, ["clear"]);
        assert.strictEqual(commands.length, 2);
        const sync = commands[1]!;
        assert.strictEqual(sync.type, "thread.goal.loop");
        if (sync.type !== "thread.goal.loop" || sync.action !== "sync") return;
        assert.strictEqual(sync.state, "blocked");
      }),
    ),
  );

  it.effect("disarms a paused experiment until its fresh session resumes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          shell: makeShell({ goalLoop: makeLoop({ kind: "experiment", state: "running" }) }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* NativeGoalReactor.NativeGoalReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);

          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          yield* Ref.set(
            fixture.shell,
            makeShell({ goalLoop: makeLoop({ kind: "experiment", state: "paused" }) }),
          );
          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          yield* Ref.set(
            fixture.shell,
            makeShell({ goalLoop: makeLoop({ kind: "experiment", state: "idle" }) }),
          );
          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          assert.deepEqual(yield* Ref.get(fixture.goalCalls), [
            { threadId: THREAD_ID, objective: "Ship the login fix", status: "active" },
            { threadId: THREAD_ID, objective: "Ship the login fix", status: "active" },
          ]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("preserves native ownership while a paused Codex experiment is stopped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({
            goalLoop: makeLoop({ kind: "experiment", mode: "native", state: "paused" }),
            session: { ...makeSession(), status: "stopped" },
          }),
          signal: goalChanged,
        });
        assert.deepEqual(commands, []);
        assert.deepEqual(goalCalls, []);
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

  it.effect("keeps a custom Codex instance in T3 mode after deactivation", () =>
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
        assert.deepEqual(goalCalls, ["clear"]);
        assert.deepEqual(commands, []);
      }),
    ),
  );

  it.effect("deactivates the same goal again after the Codex session is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          shell: makeShell({ goalLoop: makeLoop({ mode: "t3" }) }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* NativeGoalReactor.NativeGoalReactor;
          yield* reactor.start();
          yield* Deferred.succeed(fixture.activation, undefined);

          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          yield* Ref.set(
            fixture.shell,
            makeShell({
              goalLoop: makeLoop({ mode: "t3" }),
              session: { ...makeSession(), updatedAt: "2026-09-04T12:01:00.000Z" },
            }),
          );
          yield* Queue.offer(fixture.events, makeMetaUpdatedEvent());
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          assert.deepEqual(yield* Ref.get(fixture.goalCalls), ["clear", "clear"]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("hands a legacy standard goal to T3 when no live session exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ session: null }),
          signal: goalChanged,
        });
        assert.deepEqual(goalCalls, []);
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop" || command.action !== "sync") return;
        assert.strictEqual(command.mode, "t3");
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
          signal: (fixture) => Queue.offer(fixture.events, makeGoalClearedEvent()),
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

  it.effect("ignores a stale Codex clear after standard-goal takeover", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ state: "running" }) }),
          signal: (fixture) => Queue.offer(fixture.runtimeEvents, makeCodexGoalEvent(null)),
        });
        assert.deepEqual(commands, []);
      }),
    ),
  );

  it.effect("mirrors Codex completion for a restricted experiment loop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ kind: "experiment", state: "running" }) }),
          signal: (fixture) => Queue.offer(fixture.runtimeEvents, makeCodexGoalEvent("complete")),
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop" || command.action !== "sync") return;
        assert.strictEqual(command.state, "completed");
      }),
    ),
  );

  it.effect("deactivates a competing native goal instead of mirroring it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ state: "running" }) }),
          signal: (fixture) => Queue.offer(fixture.runtimeEvents, makeCodexGoalEvent("paused")),
        });
        assert.deepEqual(commands, []);
        assert.deepEqual(goalCalls, ["clear"]);
      }),
    ),
  );

  it.effect("ignores a delayed non-null notification after the native goal is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands, goalCalls } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ mode: "t3", state: "running" }) }),
          nativeGoalPresent: false,
          signal: (fixture) => Queue.offer(fixture.runtimeEvents, makeCodexGoalEvent("active")),
        });
        assert.deepEqual(commands, []);
        assert.deepEqual(goalCalls, []);
      }),
    ),
  );

  it.effect("stays quiet when Codex reports the state the loop already holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { commands } = yield* run({
          shell: makeShell({ goalLoop: makeLoop({ kind: "experiment", state: "paused" }) }),
          signal: (fixture) => Queue.offer(fixture.runtimeEvents, makeCodexGoalEvent("paused")),
        });
        assert.deepEqual(commands, []);
      }),
    ),
  );
});
