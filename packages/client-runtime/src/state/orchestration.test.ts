import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  RuntimeTaskId,
  ThreadId,
  type OrchestrationGetSubagentTranscriptInput,
  type OrchestrationGetSubagentTranscriptResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createOrchestrationEnvironmentAtoms,
  type SubagentTranscriptView,
} from "./orchestration.ts";

const ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("transcript-environment"),
  label: "Transcript environment",
  httpBaseUrl: "https://transcript.example.test",
  wsBaseUrl: "wss://transcript.example.test",
});
const THREAD_ID = ThreadId.make("thread-transcript");
const RUN_ID = RuntimeTaskId.make("opaque-transcript-run");

const item = (transcriptSequence: number) => ({
  kind: "assistant" as const,
  transcriptSequence,
  text: `item ${transcriptSequence}`,
  truncated: false,
  upstreamTruncated: false,
  createdAt: null,
});

const page = (
  entries: OrchestrationGetSubagentTranscriptResult["entries"],
  watermark: number,
  hasMore: boolean,
): OrchestrationGetSubagentTranscriptResult => ({ entries, watermark, hasMore });

const items = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => item(from + index));

const makeHarness = Effect.fn("SubagentTranscriptTest.makeHarness")(function* (
  respond: (
    input: OrchestrationGetSubagentTranscriptInput,
    callIndex: number,
  ) => OrchestrationGetSubagentTranscriptResult,
) {
  const calls = new Array<OrchestrationGetSubagentTranscriptInput>();
  const client = {
    [ORCHESTRATION_WS_METHODS.getSubagentTranscript]: (
      input: OrchestrationGetSubagentTranscriptInput,
    ) =>
      Effect.sync(() => {
        calls.push(input);
        return respond(input, calls.length - 1);
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.die("unused"),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: ENVIRONMENT,
    state,
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    runStream,
    followStream,
    stateChanges: () => SubscriptionRef.changes(state),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const clock = yield* TestClock.make();
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      Layer.succeed(Clock.Clock, clock),
    ),
  );
  const environment = createOrchestrationEnvironmentAtoms(runtime);
  return { calls, clock, environment };
});

const mountTranscript = Effect.fn("SubagentTranscriptTest.mount")(function* <E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<SubagentTranscriptView, E>>,
) {
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      registry.dispose();
    }),
  );
  return { registry, unmount };
});

const awaitView = Effect.fn("SubagentTranscriptTest.awaitView")(function* <E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<SubagentTranscriptView, E>>,
  predicate: (view: SubagentTranscriptView) => boolean,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = registry.get(atom);
    if (AsyncResult.isSuccess(result) && predicate(result.value)) return result.value;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die("Timed out waiting for transcript atom state");
});

describe("subagent transcript state machine", () => {
  it.effect("polls no faster than once per second and stops immediately on unmount", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness((_input, callIndex) =>
          callIndex === 0 ? page([item(1)], 1, false) : page([item(2)], 2, false),
        );
        const atom = harness.environment.subagentTranscript({
          environmentId: ENVIRONMENT.environmentId,
          input: { threadId: THREAD_ID, runId: RUN_ID, terminal: false },
        });
        const mounted = yield* mountTranscript(atom);
        yield* awaitView(mounted.registry, atom, (view) => view.watermark === 1);
        for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;

        yield* harness.clock.adjust(Duration.millis(999));
        yield* Effect.yieldNow;
        expect(harness.calls).toHaveLength(1);

        yield* harness.clock.adjust(Duration.millis(1));
        yield* Effect.yieldNow;
        expect(harness.calls).toHaveLength(2);
        yield* awaitView(mounted.registry, atom, (view) => view.watermark === 2);
        expect(harness.calls).toHaveLength(2);

        mounted.unmount();
        yield* harness.clock.adjust(Duration.seconds(5));
        yield* Effect.yieldNow;
        expect(harness.calls).toHaveLength(2);
      }),
    ),
  );

  it.effect("reconciles an advanced watermark with durable gap markers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness((input) => {
          if (input.afterSequence === 1) return page(items(2, 201), 300, true);
          if (input.afterSequence === 201) {
            return page(
              [{ kind: "gap", fromSequence: 202, toSequence: 250 }, ...items(251, 300)],
              300,
              false,
            );
          }
          return page([item(1)], 1, false);
        });
        const atom = harness.environment.subagentTranscript({
          environmentId: ENVIRONMENT.environmentId,
          input: { threadId: THREAD_ID, runId: RUN_ID, terminal: false },
        });
        const mounted = yield* mountTranscript(atom);
        yield* awaitView(mounted.registry, atom, (view) => view.watermark === 1);
        for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;

        yield* harness.clock.adjust(Duration.seconds(1));
        const view = yield* awaitView(
          mounted.registry,
          atom,
          (candidate) => candidate.watermark === 300,
        );

        expect(harness.calls).toHaveLength(3);
        expect(view.entries).toContainEqual({
          kind: "gap",
          fromSequence: 202,
          toSequence: 250,
        });
        expect(view.entries.at(-1)).toEqual(item(300));
      }),
    ),
  );

  it.effect("performs exactly one terminal catch-up across the retained 500 items", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness((input) => {
          if (input.afterSequence === 500) return page([], 500, false);
          if (input.beforeSequence !== undefined) {
            const toSequence = input.beforeSequence - 1;
            const fromSequence = Math.max(1, toSequence - 49);
            return page(items(fromSequence, toSequence), 500, fromSequence > 1);
          }
          return page(items(451, 500), 500, true);
        });
        const atom = harness.environment.subagentTranscript({
          environmentId: ENVIRONMENT.environmentId,
          input: { threadId: THREAD_ID, runId: RUN_ID, terminal: true },
        });
        const mounted = yield* mountTranscript(atom);
        const view = yield* awaitView(
          mounted.registry,
          atom,
          (candidate) => candidate.terminalCatchUpComplete,
        );

        expect(view.entries.filter((entry) => "transcriptSequence" in entry)).toHaveLength(500);
        expect(view.hasOlder).toBe(false);
        expect(harness.calls).toHaveLength(11);

        yield* harness.clock.adjust(Duration.seconds(5));
        yield* Effect.yieldNow;
        expect(harness.calls).toHaveLength(11);
      }),
    ),
  );

  it.effect("loads older pages only after the explicit navigation request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness((input) =>
          input.beforeSequence === 201
            ? page(items(1, 200), 400, false)
            : page(items(201, 400), 400, true),
        );
        const atom = harness.environment.subagentTranscript({
          environmentId: ENVIRONMENT.environmentId,
          input: { threadId: THREAD_ID, runId: RUN_ID, terminal: false },
        });
        const mounted = yield* mountTranscript(atom);
        yield* awaitView(mounted.registry, atom, (view) => view.entries.length === 200);
        expect(harness.calls).toHaveLength(1);

        expect(
          harness.environment.requestOlderSubagentTranscript({
            environmentId: ENVIRONMENT.environmentId,
            input: { threadId: THREAD_ID, runId: RUN_ID },
          }),
        ).toBe(true);
        const view = yield* awaitView(mounted.registry, atom, (candidate) => !candidate.hasOlder);

        expect(view.entries.filter((entry) => "transcriptSequence" in entry)).toHaveLength(400);
        expect(harness.calls).toHaveLength(2);
        expect(harness.calls[1]?.beforeSequence).toBe(201);
      }),
    ),
  );
});
