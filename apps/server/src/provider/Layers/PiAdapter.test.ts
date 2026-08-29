// @effect-diagnostics nodeBuiltinImport:off - the fake pi fixture drives a real stdio process through Node spawn and filesystem APIs.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  PiSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const PROVIDER = ProviderDriverKind.make("pi");
const THREAD_ID = ThreadId.make("pi-adapter-test-thread");
const FIXTURE_SCRIPT_PATH = NodePath.join(import.meta.dirname, "../testUtils/fake-pi.mjs");

interface Fixture {
  readonly binaryPath: string;
  readonly logPath: string;
  readonly nativeSessionFile: string;
}

const makeFixture = (): Fixture => {
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-adapter-test-"));
  const scriptPath = NodePath.join(fixtureRoot, "fake-pi.mjs");
  NodeFS.writeFileSync(scriptPath, NodeFS.readFileSync(FIXTURE_SCRIPT_PATH, "utf8"));
  const shimPath = NodePath.join(fixtureRoot, "pi");
  NodeFS.writeFileSync(shimPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`);
  NodeFS.chmodSync(shimPath, 0o755);
  const logPath = NodePath.join(fixtureRoot, "received.ndjson");
  NodeFS.writeFileSync(logPath, "");
  const nativeSessionFile = NodePath.join(fixtureRoot, "native-session.jsonl");
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_SESSION_FILE = nativeSessionFile;
  delete process.env.FAKE_PI_VETO;
  delete process.env.FAKE_PI_BUSY;
  process.env.FAKE_PI_SLOW_PROMPT_MS = "10";
  return { binaryPath: shimPath, logPath, nativeSessionFile };
};

const testLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const provideTestEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(testLayer));

const makeTestAdapter = (settings: PiSettings) =>
  makePiAdapter(settings, { instanceId: undefined, environment: process.env });

const waitFor = (predicate: () => boolean, description: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (predicate()) return;
      yield* Effect.sleep(25);
    }
    throw new Error(`Timed out waiting for ${description}.`);
  });

const collectEvents = (stream: Stream.Stream<ProviderRuntimeEvent>) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    yield* Stream.runForEach(stream, (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ).pipe(Effect.forkScoped, Effect.ignore);
    return events;
  });

const readLogLines = (fixture: Fixture): ReadonlyArray<Record<string, unknown>> =>
  NodeFS.readFileSync(fixture.logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const payloadOf = (event: ProviderRuntimeEvent) =>
  event.payload as {
    delta?: string;
    state?: string;
    reason?: string;
    resume?: unknown;
  };

describe("PiAdapter", () => {
  it.live("starts a native session and reports a versioned resume cursor", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const events = yield* collectEvents(adapter.streamEvents);
      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      expect(session.provider).toBe(PROVIDER);
      expect(session.status).toBe("ready");
      expect(session.activeTurnId).toBeUndefined();
      const resume = session.resumeCursor as { schemaVersion?: number; sessionPath?: string };
      expect(resume.schemaVersion).toBe(1);
      expect(resume.sessionPath).toBe(fixture.nativeSessionFile);
      expect(yield* adapter.hasSession(THREAD_ID)).toBe(true);
      expect(events.filter((event) => event.type === "session.started")).toHaveLength(1);
      yield* adapter.stopSession(THREAD_ID);
      expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
    }).pipe(provideTestEnv),
  );

  it.live("runs a turn end to end and terminalizes on agent_settled", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const events = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      const result = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "say hello" });
      yield* waitFor(
        () =>
          events.some(
            (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
          ),
        "turn.completed",
      );
      expect(result.threadId).toBe(THREAD_ID);
      expect(result.turnId).toBeDefined();
      const deltas = events
        .filter((event) => event.type === "content.delta")
        .map((event) => payloadOf(event).delta);
      expect(deltas.join("")).toBe("Hello world");
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
      expect(events.some((event) => event.type === "item.completed")).toBe(true);
      // The session stays reusable after the turn settles.
      const sessions = yield* adapter.listSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.status).toBe("ready");
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("resumes the native session through switch_session", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      yield* collectEvents(adapter.streamEvents);
      const first = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(THREAD_ID);
      const resumed = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
        resumeCursor: first.resumeCursor,
      });
      expect(resumed.resumeCursor).toEqual(first.resumeCursor);
      const received = readLogLines(fixture);
      const switchRequests = received.filter((line) => line.type === "switch_session");
      expect(switchRequests).toHaveLength(1);
      expect((switchRequests[0] as { sessionPath?: string } | undefined)?.sessionPath).toBe(
        fixture.nativeSessionFile,
      );
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("surfaces a vetoed session switch instead of adopting the wrong session", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      yield* collectEvents(adapter.streamEvents);
      const first = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(THREAD_ID);
      process.env.FAKE_PI_VETO = "1";
      const result = yield* Effect.exit(
        adapter.startSession({
          threadId: THREAD_ID,
          provider: PROVIDER,
          runtimeMode: "full-access",
          resumeCursor: first.resumeCursor,
        }),
      );
      delete process.env.FAKE_PI_VETO;
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
    }).pipe(provideTestEnv),
  );

  it.live("interrupts an active turn with abort and reports turn.aborted", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      process.env.FAKE_PI_SLOW_PROMPT_MS = "5000";
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const events = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      const started = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "keep going" });
      yield* adapter.interruptTurn(THREAD_ID, started.turnId);
      yield* waitFor(
        () =>
          events.some(
            (event) => event.type === "turn.aborted" && payloadOf(event).reason === "interrupted",
          ),
        "turn.aborted",
      );
      const received = readLogLines(fixture);
      expect(received.some((line) => line.type === "abort")).toBe(true);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("settles a command-only prompt through the idle probe without agent events", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const events = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/only an extension command" });
      yield* waitFor(
        () =>
          events.some(
            (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
          ),
        "command-only turn.completed",
      );
      // No agent activity ever arrived: no deltas, no tool items.
      expect(events.some((event) => event.type === "content.delta")).toBe(false);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("hoists $skill chips into the leading /skill: command", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const events = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "please $research the API" });
      yield* waitFor(
        () =>
          events.some(
            (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
          ),
        "skill-chip turn.completed",
      );
      // Pi expands skills only as leading /skill:name commands, so the chip
      // the composer inserts must be hoisted before the prompt reaches Pi.
      const prompts = readLogLines(fixture).filter((line) => line.type === "prompt");
      expect(prompts).toHaveLength(1);
      expect((prompts[0] as { message?: string } | undefined)?.message).toBe(
        "/skill:research please the API",
      );
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("keeps stream items isolated across concurrent sessions", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const events = yield* collectEvents(adapter.streamEvents);
      const threadA = ThreadId.make("pi-adapter-test-thread-a");
      const threadB = ThreadId.make("pi-adapter-test-thread-b");
      yield* adapter.startSession({
        threadId: threadA,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: threadB,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: threadA, input: "INTERLEAVE slow turn" });
      // A's first delta creates its stream item; B's turn start must not
      // clear A's in-flight item state.
      yield* waitFor(
        () => events.some((event) => event.type === "item.started" && event.threadId === threadA),
        "A item.started",
      );
      yield* adapter.sendTurn({ threadId: threadB, input: "fast turn" });
      yield* waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "turn.completed" &&
              event.threadId === threadA &&
              payloadOf(event).state === "completed",
          ),
        "A turn.completed",
      );
      yield* waitFor(
        () =>
          events.some(
            (event) =>
              event.type === "turn.completed" &&
              event.threadId === threadB &&
              payloadOf(event).state === "completed",
          ),
        "B turn.completed",
      );
      yield* adapter.stopSession(threadA);
      yield* adapter.stopSession(threadB);
      const startedItems = events.filter(
        (event) => event.type === "item.started" && event.threadId === threadA,
      );
      expect(startedItems).toHaveLength(1);
    }).pipe(provideTestEnv),
  );

  it.live("fails a rejected prompt instead of faking success", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const events = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "REJECT this please" });
      yield* waitFor(
        () =>
          events.some(
            (event) => event.type === "turn.completed" && payloadOf(event).state === "failed",
          ),
        "failed turn.completed",
      );
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );
});
