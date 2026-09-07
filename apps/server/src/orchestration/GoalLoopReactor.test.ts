import {
  CheckpointRef,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ThreadGoalLoop,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ExperimentService } from "../experiments/ExperimentService.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as GoalLoopReactor from "./GoalLoopReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusTest } from "./Layers/RuntimeReceiptBus.ts";

const NOW = "2026-09-03T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("goal-loop-project");
const THREAD_ID = ThreadId.make("goal-loop-thread");
const TURN_ID = TurnId.make("goal-loop-turn");

function makeLoop(overrides: Partial<ThreadGoalLoop> = {}): ThreadGoalLoop {
  return {
    kind: "standard",
    state: "running",
    mode: "t3",
    iterations: 1,
    maxIterations: 10,
    reason: null,
    experiment: null,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSession(
  overrides: {
    readonly status?: OrchestrationSession["status"];
    readonly providerName?: string;
    readonly instanceId?: string;
    readonly activeTurnId?: TurnId | null;
  } = {},
): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status: overrides.status ?? "idle",
    providerName: overrides.providerName ?? "claudeAgent",
    providerInstanceId: ProviderInstanceId.make(overrides.instanceId ?? "claudeAgent"),
    runtimeMode: "full-access",
    activeTurnId: overrides.activeTurnId ?? null,
    lastError: null,
    updatedAt: NOW,
  };
}

function makeShell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Goal loop thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "opus",
    },
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
    goal: "Ship the goal loop",
    goalLoop: makeLoop(),
    session: makeSession(),
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeAssistantMessage(text: string, turnId: TurnId | null = TURN_ID): OrchestrationMessage {
  return {
    id: MessageId.make(`assistant:${text.slice(0, 8)}:${turnId ?? "none"}`),
    role: "assistant",
    text,
    turnId,
    streaming: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeDetail(
  shell: OrchestrationThreadShell,
  messages: ReadonlyArray<OrchestrationMessage>,
): OrchestrationThread {
  return {
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    voiceNotifications: shell.voiceNotifications,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    latestTurn: shell.latestTurn,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    archivedAt: shell.archivedAt,
    settledOverride: shell.settledOverride,
    settledAt: shell.settledAt,
    goal: shell.goal ?? null,
    goalLoop: shell.goalLoop ?? null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: shell.session,
  };
}

function makeTurnDiffCompletedEvent(
  threadId: ThreadId = THREAD_ID,
  turnId: TurnId = TURN_ID,
): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make(`event-turn-diff:${turnId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.turn-diff-completed",
    payload: {
      threadId,
      turnId,
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/goal-loop-thread/1"),
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: NOW,
    },
  };
}

const RESUMED_AT = "2026-09-03T12:05:00.000Z";

/**
 * The event a `thread.goal.loop` resume/reset produces. `resumed` is what the
 * reactor keys on; a freshly set goal emits the same event without it.
 */
function makeGoalLoopUpdatedEvent(input: {
  readonly loop: ThreadGoalLoop | null;
  readonly resumed?: boolean;
  readonly threadId?: ThreadId;
  readonly key?: string;
}): OrchestrationEvent {
  const threadId = input.threadId ?? THREAD_ID;
  return {
    sequence: 2,
    eventId: EventId.make(`event-goal-loop:${input.key ?? threadId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: RESUMED_AT,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.goal-loop-updated",
    payload: {
      threadId,
      loop: input.loop,
      ...(input.resumed === true ? { resumed: true } : {}),
    },
  };
}

interface HarnessOptions {
  readonly shell: OrchestrationThreadShell;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
  /** Shell snapshot the boot sweep reads. Empty by default. */
  readonly sweepThreads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly onDispatch?: (command: OrchestrationCommand) => Effect.Effect<void>;
  readonly experiment?: boolean;
}

const makeHarness = Effect.fn("makeGoalLoopHarness")(function* (options: HarnessOptions) {
  const activation = yield* Deferred.make<void>();
  const shell = yield* Ref.make(options.shell);
  const messages = yield* Ref.make(options.messages ?? []);
  const shellReads = yield* Queue.unbounded<ThreadId>();
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  // A queue, not a PubSub: `Stream.fromPubSub` only subscribes once the
  // forked stream starts running, so a publish issued right after `start()`
  // can land in that gap and never reach the reactor.
  const events = yield* Queue.unbounded<OrchestrationEvent>();

  const snapshot: OrchestrationShellSnapshot = {
    snapshotSequence: 1,
    projects: [],
    threads: options.sweepThreads ?? [],
    updatedAt: NOW,
  };

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1 }),
    );

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getShellSnapshot: () => Effect.succeed(snapshot),
      getThreadShellById: (threadId) =>
        Queue.offer(shellReads, threadId).pipe(
          Effect.andThen(Ref.get(shell)),
          Effect.map((current) => (current.id === threadId ? Option.some(current) : Option.none())),
        ),
      getThreadDetailById: (threadId) =>
        Effect.all([Ref.get(shell), Ref.get(messages)]).pipe(
          Effect.map(([current, entries]) =>
            current.id === threadId
              ? Option.some(makeDetail(current, entries))
              : Option.none<OrchestrationThread>(),
          ),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
    RuntimeReceiptBusTest,
    options.experiment
      ? Layer.mock(ExperimentService)({
          resume: () =>
            Effect.succeed({
              runId: "experiment-run",
              configDigest: "a".repeat(64),
              phase: "ready",
              metric: { name: "score", direction: "maximize", minimumImprovement: 0.5 },
              experimentsRun: 0,
              experimentsKept: 0,
              experimentsRestored: 0,
              baselineMetric: 1,
              bestMetric: 1,
              lastMetric: 1,
              elapsedSeconds: 1,
              maxExperiments: 10,
              maxTotalSeconds: 600,
              lastError: null,
            }),
          canContinue: () => Effect.succeed(true),
        })
      : Layer.empty,
  );

  return {
    activation,
    shell,
    messages,
    shellReads,
    commands,
    events,
    layer: GoalLoopReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

/**
 * Starts the reactor and settles the boot sweep, then publishes `events` and
 * waits until each one's shell read has landed and the worker has drained.
 * Every evaluated signal reads the shell exactly once, so the read queue is
 * the reactor's own progress marker — no sleeps, no polling.
 */
const runSignals = Effect.fn("runGoalLoopSignals")(function* (input: {
  readonly reactor: GoalLoopReactor.GoalLoopReactor["Service"];
  readonly activation: Deferred.Deferred<void>;
  readonly shellReads: Queue.Queue<ThreadId>;
  readonly events: Queue.Queue<OrchestrationEvent>;
  readonly sweepReads?: number;
  readonly signals?: ReadonlyArray<OrchestrationEvent>;
}) {
  yield* input.reactor.start();
  yield* Deferred.succeed(input.activation, undefined);
  for (let index = 0; index < (input.sweepReads ?? 0); index += 1) {
    yield* Queue.take(input.shellReads);
  }
  yield* input.reactor.drain;
  for (const event of input.signals ?? []) {
    yield* Queue.offer(input.events, event);
    yield* Queue.take(input.shellReads);
    yield* input.reactor.drain;
  }
});

describe("scanGoalSignal", () => {
  it("reads the last tag, case-insensitively", () => {
    assert.deepEqual(GoalLoopReactor.scanGoalSignal("all done <GOAL_COMPLETE>"), {
      kind: "complete",
    });
    assert.deepEqual(
      GoalLoopReactor.scanGoalSignal(
        "<goal_complete> then <goal_blocked>need a key</goal_blocked>",
      ),
      { kind: "blocked", reason: "need a key" },
    );
    assert.deepEqual(GoalLoopReactor.scanGoalSignal("<goal_blocked>  </goal_blocked>"), {
      kind: "blocked",
      reason: "Agent reported it is blocked",
    });
    assert.equal(GoalLoopReactor.scanGoalSignal("still working"), null);
  });
});

describe("GoalLoopReactor", () => {
  /** Runs one end-of-turn signal against a fixture and returns the dispatches. */
  const dispatchesFor = Effect.fn("goalLoopDispatchesFor")(function* (options: HarnessOptions) {
    const fixture = yield* makeHarness(options);
    return yield* Effect.gen(function* () {
      const reactor = yield* GoalLoopReactor.GoalLoopReactor;
      yield* runSignals({
        reactor,
        activation: fixture.activation,
        shellReads: fixture.shellReads,
        events: fixture.events,
        signals: [makeTurnDiffCompletedEvent()],
      });
      return yield* Ref.get(fixture.commands);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("starts a continuation turn once a turn has fully ended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* dispatchesFor({
          shell: makeShell(),
          messages: [makeAssistantMessage("Made progress, more to do.")],
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.turn.start");
        if (command.type !== "thread.turn.start") return;
        assert.strictEqual(
          command.commandId,
          "server:goal-continue:goal-loop-thread:goal-loop-turn",
        );
        assert.strictEqual(command.message.text, GoalLoopReactor.GOAL_CONTINUE_MESSAGE);
        assert.strictEqual(command.continuation, true);
        assert.strictEqual(command.runtimeMode, "full-access");
        assert.strictEqual(command.interactionMode, "default");
      }),
    ),
  );

  it.effect(
    "keys the continuation on the ended turn, so a repeated signal cannot double-start",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeHarness({
            shell: makeShell(),
            messages: [makeAssistantMessage("Still going.")],
          });
          yield* Effect.gen(function* () {
            const reactor = yield* GoalLoopReactor.GoalLoopReactor;
            yield* runSignals({
              reactor,
              activation: fixture.activation,
              shellReads: fixture.shellReads,
              events: fixture.events,
              signals: [makeTurnDiffCompletedEvent(), makeTurnDiffCompletedEvent()],
            });
            const commands = yield* Ref.get(fixture.commands);
            assert.deepStrictEqual(
              [...new Set(commands.map((command) => command.commandId))],
              ["server:goal-continue:goal-loop-thread:goal-loop-turn"],
            );
          }).pipe(Effect.provide(fixture.layer));
        }),
      ),
  );

  it.effect("completes the loop on <goal_complete>", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* dispatchesFor({
          shell: makeShell(),
          messages: [
            makeAssistantMessage("early note"),
            makeAssistantMessage("Verified and shipped. <goal_complete>"),
          ],
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop") return;
        assert.strictEqual(command.action, "complete");
      }),
    ),
  );

  it.effect("blocks the loop on <goal_blocked> with the agent's reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* dispatchesFor({
          shell: makeShell(),
          messages: [makeAssistantMessage("<goal_blocked> I need the API key. </goal_blocked>")],
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.goal.loop");
        if (command.type !== "thread.goal.loop") return;
        assert.strictEqual(command.action, "block");
        assert.strictEqual(command.reason, "I need the API key.");
      }),
    ),
  );

  it.effect("blocks after two turns that produced no assistant output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({ shell: makeShell(), messages: [] });
        yield* Effect.gen(function* () {
          const reactor = yield* GoalLoopReactor.GoalLoopReactor;
          yield* runSignals({
            reactor,
            activation: fixture.activation,
            shellReads: fixture.shellReads,
            events: fixture.events,
            signals: [makeTurnDiffCompletedEvent(), makeTurnDiffCompletedEvent()],
          });
          const commands = yield* Ref.get(fixture.commands);
          assert.strictEqual(commands.length, 2);
          assert.strictEqual(commands[0]!.type, "thread.turn.start");
          const second = commands[1]!;
          assert.strictEqual(second.type, "thread.goal.loop");
          if (second.type !== "thread.goal.loop") return;
          assert.strictEqual(second.action, "block");
          assert.strictEqual(second.reason, "Agent produced no output on two continuations");
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  const stalledCases: ReadonlyArray<{
    readonly label: string;
    readonly shell: OrchestrationThreadShell;
  }> = [
    { label: "the loop is paused", shell: makeShell({ goalLoop: makeLoop({ state: "paused" }) }) },
    { label: "an approval is pending", shell: makeShell({ hasPendingApprovals: true }) },
    {
      label: "the iteration budget is spent",
      shell: makeShell({ goalLoop: makeLoop({ iterations: 10, maxIterations: 10 }) }),
    },
    {
      // Stored mode still reads t3 (the decider only saw the instance id);
      // the reactor re-derives it from the bound session's real driver.
      label: "the provider drives the goal natively",
      shell: makeShell({
        modelSelection: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5" },
        session: makeSession({ providerName: "codex", instanceId: "codex-work" }),
      }),
    },
    {
      label: "the provider session is still running",
      shell: makeShell({ session: makeSession({ status: "running", activeTurnId: TURN_ID }) }),
    },
    {
      label: "the turn ended in a session error",
      shell: makeShell({ session: makeSession({ status: "error" }) }),
    },
  ];

  for (const stalled of stalledCases) {
    it.effect(`dispatches nothing when ${stalled.label}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const commands = yield* dispatchesFor({
            shell: stalled.shell,
            messages: [makeAssistantMessage("Still going.")],
          });
          assert.deepStrictEqual(commands, []);
        }),
      ),
    );
  }

  it.effect("completes again after the goal is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secondTurn = TurnId.make("goal-loop-turn-2");
        const fixture = yield* makeHarness({
          shell: makeShell(),
          messages: [makeAssistantMessage("First goal done. <goal_complete>")],
        });
        yield* Effect.gen(function* () {
          const reactor = yield* GoalLoopReactor.GoalLoopReactor;
          yield* runSignals({
            reactor,
            activation: fixture.activation,
            shellReads: fixture.shellReads,
            events: fixture.events,
            signals: [makeTurnDiffCompletedEvent()],
          });

          // The user replaces the goal (`thread.meta.update`) and sends a turn:
          // the loop resets to a fresh generation on the same thread.
          yield* Ref.set(
            fixture.shell,
            makeShell({ goal: "Ship the follow-up", goalLoop: makeLoop({ iterations: 0 }) }),
          );
          yield* Ref.set(fixture.messages, [
            makeAssistantMessage("Second goal done. <goal_complete>", secondTurn),
          ]);
          yield* Queue.offer(fixture.events, makeTurnDiffCompletedEvent(THREAD_ID, secondTurn));
          yield* Queue.take(fixture.shellReads);
          yield* reactor.drain;

          const commands = yield* Ref.get(fixture.commands);
          // The engine replays an already-accepted command id instead of
          // re-running the decider, so two ids means two `thread.goal-loop-updated`
          // events; one id would leave the replaced goal's loop stuck running.
          assert.deepStrictEqual(
            commands.map((command) => [command.type, command.commandId]),
            [
              ["thread.goal.loop", "server:goal-complete:goal-loop-thread:goal-loop-turn"],
              ["thread.goal.loop", "server:goal-complete:goal-loop-thread:goal-loop-turn-2"],
            ],
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  /** Runs the given signals against a fixture and returns the dispatches. */
  const dispatchesForSignals = Effect.fn("goalLoopDispatchesForSignals")(function* (
    options: HarnessOptions & { readonly signals: ReadonlyArray<OrchestrationEvent> },
  ) {
    const fixture = yield* makeHarness(options);
    return yield* Effect.gen(function* () {
      const reactor = yield* GoalLoopReactor.GoalLoopReactor;
      yield* runSignals({
        reactor,
        activation: fixture.activation,
        shellReads: fixture.shellReads,
        events: fixture.events,
        signals: options.signals,
      });
      return yield* Ref.get(fixture.commands);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("resuming a paused loop starts the next turn without re-reading the last reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* dispatchesForSignals({
          // Post-resume shell: the decider already moved paused -> idle.
          shell: makeShell({ goalLoop: makeLoop({ state: "idle", updatedAt: RESUMED_AT }) }),
          // The reply that blocked the loop is still the last one. Scanning it
          // would immediately re-block the loop the user just resumed.
          messages: [makeAssistantMessage("<goal_blocked>I need the API key.</goal_blocked>")],
          signals: [
            makeGoalLoopUpdatedEvent({
              loop: makeLoop({ state: "idle", updatedAt: RESUMED_AT }),
              resumed: true,
            }),
          ],
        });
        assert.strictEqual(commands.length, 1);
        const command = commands[0]!;
        assert.strictEqual(command.type, "thread.turn.start");
        if (command.type !== "thread.turn.start") return;
        assert.strictEqual(
          command.commandId,
          `server:goal-continue:goal-loop-thread:resume:${RESUMED_AT}`,
        );
        assert.strictEqual(command.continuation, true);
      }),
    ),
  );

  it.effect("the activation wake starts the first T3 experiment continuation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const loop = makeLoop({
          kind: "experiment",
          state: "idle",
          iterations: 0,
          updatedAt: RESUMED_AT,
        });
        const commands = yield* dispatchesForSignals({
          shell: makeShell({ goalLoop: loop }),
          signals: [makeGoalLoopUpdatedEvent({ loop, resumed: true })],
          experiment: true,
        });
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0]!.type, "thread.turn.start");
      }),
    ),
  );

  it.effect("continuing past the cap (reset) starts the next turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resetLoop = makeLoop({ state: "idle", iterations: 0, updatedAt: RESUMED_AT });
        const commands = yield* dispatchesForSignals({
          shell: makeShell({ goalLoop: resetLoop }),
          messages: [makeAssistantMessage("Ran out of iterations.")],
          signals: [makeGoalLoopUpdatedEvent({ loop: resetLoop, resumed: true })],
        });
        assert.strictEqual(commands.length, 1);
        assert.strictEqual(commands[0]!.type, "thread.turn.start");
      }),
    ),
  );

  it.effect("a freshly set goal waits for the user's first message", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeHarness({
          shell: makeShell({ goalLoop: makeLoop({ state: "idle", iterations: 0 }) }),
          messages: [makeAssistantMessage("Anything else?")],
        });
        yield* Effect.gen(function* () {
          const reactor = yield* GoalLoopReactor.GoalLoopReactor;
          // Queued ahead of the tracer below, and before the reactor starts —
          // the harness uses a buffered queue, so nothing is lost. No
          // `resumed`: the goal was set, not resumed.
          yield* Queue.offer(
            fixture.events,
            makeGoalLoopUpdatedEvent({ loop: makeLoop({ state: "idle", iterations: 0 }) }),
          );
          yield* runSignals({
            reactor,
            activation: fixture.activation,
            shellReads: fixture.shellReads,
            events: fixture.events,
            // A signal for an unknown thread: it reads the shell (so the wait
            // in `runSignals` lands) and dispatches nothing, proving the loop
            // update ahead of it in the queue produced nothing either.
            signals: [makeTurnDiffCompletedEvent(ThreadId.make("other-thread"))],
          });
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a duplicated resume event collapses onto one command id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resumedLoop = makeLoop({ state: "idle", updatedAt: RESUMED_AT });
        const commands = yield* dispatchesForSignals({
          shell: makeShell({ goalLoop: resumedLoop }),
          messages: [makeAssistantMessage("Paused mid-flight.")],
          signals: [
            makeGoalLoopUpdatedEvent({ loop: resumedLoop, resumed: true, key: "a" }),
            makeGoalLoopUpdatedEvent({ loop: resumedLoop, resumed: true, key: "b" }),
          ],
        });
        // The engine replays an accepted command id instead of starting a
        // second turn, so one id across both signals is the collapse.
        assert.deepStrictEqual(
          [...new Set(commands.map((command) => command.commandId))],
          [`server:goal-continue:goal-loop-thread:resume:${RESUMED_AT}`],
        );
      }),
    ),
  );

  it.effect("boot sweep continues a loop left running by a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const shell = makeShell({ goalLoop: makeLoop({ iterations: 3 }) });
        const fixture = yield* makeHarness({
          shell,
          messages: [makeAssistantMessage("Interrupted by a restart.", null)],
          sweepThreads: [shell],
        });
        yield* Effect.gen(function* () {
          const reactor = yield* GoalLoopReactor.GoalLoopReactor;
          yield* runSignals({
            reactor,
            activation: fixture.activation,
            shellReads: fixture.shellReads,
            events: fixture.events,
            sweepReads: 1,
          });
          const commands = yield* Ref.get(fixture.commands);
          assert.strictEqual(commands.length, 1);
          assert.strictEqual(
            commands[0]!.commandId,
            `server:goal-continue:goal-loop-thread:boot:${NOW}`,
          );
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
