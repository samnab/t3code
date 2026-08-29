// @effect-diagnostics nodeBuiltinImport:off - the fake pi fixture drives a real stdio process through Node spawn and filesystem APIs.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
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
  readonly closedPath: string;
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
  const closedPath = NodePath.join(fixtureRoot, "closed");
  const nativeSessionFile = NodePath.join(fixtureRoot, "native-session.jsonl");
  process.env.FAKE_PI_CLOSED = closedPath;
  process.env.FAKE_PI_LOG = logPath;
  process.env.FAKE_PI_SESSION_FILE = nativeSessionFile;
  delete process.env.FAKE_PI_BUSY;
  delete process.env.FAKE_PI_FAIL_COMMAND;
  delete process.env.FAKE_PI_VETO;
  return { binaryPath: shimPath, closedPath, logPath, nativeSessionFile };
};

const testLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const provideTestEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(testLayer));

const makeTestAdapter = (settings: PiSettings) =>
  makePiAdapter(settings, { instanceId: undefined, environment: process.env });

interface EventWaiter {
  readonly predicate: (event: ProviderRuntimeEvent) => boolean;
  readonly deferred: Deferred.Deferred<ProviderRuntimeEvent>;
}

const collectEvents = (stream: Stream.Stream<ProviderRuntimeEvent>) =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const waiters: EventWaiter[] = [];
    yield* Stream.runForEach(stream, (event) =>
      Effect.gen(function* () {
        events.push(event);
        for (const waiter of waiters) {
          if (waiter.predicate(event)) yield* Deferred.succeed(waiter.deferred, event);
        }
      }),
    ).pipe(Effect.forkScoped, Effect.ignore);
    return {
      events,
      waitFor: (predicate: (event: ProviderRuntimeEvent) => boolean) =>
        Effect.gen(function* () {
          const existing = events.find(predicate);
          if (existing !== undefined) return existing;
          const deferred = yield* Deferred.make<ProviderRuntimeEvent>();
          const waiter = { predicate, deferred };
          waiters.push(waiter);
          const arrivedBeforeRegistration = events.find(predicate);
          if (arrivedBeforeRegistration !== undefined) {
            yield* Deferred.succeed(deferred, arrivedBeforeRegistration);
          }
          return yield* Deferred.await(deferred).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
              }),
            ),
          );
        }),
    };
  });

const waitForFile = (path: string) =>
  Effect.callback<void>((resume) => {
    if (NodeFS.existsSync(path)) {
      resume(Effect.void);
      return;
    }
    const watcher = NodeFS.watch(NodePath.dirname(path), () => {
      if (!NodeFS.existsSync(path)) return;
      watcher.close();
      resume(Effect.void);
    });
    if (NodeFS.existsSync(path)) {
      watcher.close();
      resume(Effect.void);
    }
    return Effect.sync(() => watcher.close());
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
      const collector = yield* collectEvents(adapter.streamEvents);
      const { events } = collector;
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

  it.live(
    "stops sessions created after adapter construction through stopAll and finalization",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const adapter = yield* makeTestAdapter(
              decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
            );
            yield* adapter.startSession({
              threadId: THREAD_ID,
              provider: PROVIDER,
              runtimeMode: "full-access",
            });
            yield* adapter.stopAll();
            const stopAllStopped = !(yield* adapter.hasSession(THREAD_ID));
            if (!stopAllStopped) yield* adapter.stopSession(THREAD_ID);
            yield* adapter.startSession({
              threadId: THREAD_ID,
              provider: PROVIDER,
              runtimeMode: "full-access",
            });
            return { adapter, stopAllStopped };
          }),
        );
        const finalizerStopped = !(yield* result.adapter.hasSession(THREAD_ID));
        if (!finalizerStopped) yield* result.adapter.stopSession(THREAD_ID);
        expect(result.stopAllStopped).toBe(true);
        expect(finalizerStopped).toBe(true);
      }).pipe(provideTestEnv),
  );

  it.live("runs a turn end to end and terminalizes on agent_settled", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      const { events } = collector;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      const result = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "say hello" });
      yield* collector.waitFor(
        (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
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

  it.live("closes an unattached Pi process when session startup fails", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const closed = yield* waitForFile(fixture.closedPath).pipe(Effect.forkScoped);
      process.env.FAKE_PI_FAIL_COMMAND = "get_state";
      const result = yield* Effect.exit(
        adapter.startSession({
          threadId: THREAD_ID,
          provider: PROVIDER,
          runtimeMode: "full-access",
        }),
      ).pipe(Effect.ensuring(Effect.sync(() => delete process.env.FAKE_PI_FAIL_COMMAND)));
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
      yield* Fiber.join(closed);
    }).pipe(provideTestEnv),
  );

  it.live("interrupts an active turn with abort and reports turn.aborted", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      const started = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "WAIT_FOR_ABORT" });
      yield* collector.waitFor((event) => event.type === "turn.started");
      yield* adapter.interruptTurn(THREAD_ID, started.turnId);
      yield* collector.waitFor(
        (event) => event.type === "turn.aborted" && payloadOf(event).reason === "interrupted",
      );
      const received = readLogLines(fixture);
      expect(received.some((line) => line.type === "abort")).toBe(true);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("cancels a pending native extension dialog when an interrupted turn settles", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      const { events } = collector;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      const started = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "UI_WAIT_FOR_ABORT" });
      const opened = yield* collector.waitFor(
        (event) => event.type === "request.opened" && event.payload.detail === "Keep waiting?",
      );
      if (opened.type !== "request.opened" || opened.requestId === undefined) {
        throw new Error("Expected confirmation request.");
      }
      const requestId = ApprovalRequestId.make(opened.requestId);

      // The fake acknowledges abort only after receiving this dialog cancellation.
      yield* adapter.interruptTurn(THREAD_ID, started.turnId);
      yield* collector.waitFor(
        (event) => event.type === "turn.aborted" && payloadOf(event).reason === "interrupted",
      );

      expect(
        readLogLines(fixture).filter(
          (line) => line.type === "extension_ui_response" && line.id === "ui-abort",
        ),
      ).toEqual([{ type: "extension_ui_response", id: "ui-abort", cancelled: true }]);
      const resolved = events.filter(
        (event) => event.type === "request.resolved" && event.requestId === opened.requestId,
      );
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        type: "request.resolved",
        requestId: opened.requestId,
        payload: { requestType: "unknown", decision: "cancel" },
      });
      expect(
        Exit.isFailure(
          yield* Effect.exit(adapter.respondToRequest(THREAD_ID, requestId, "cancel")),
        ),
      ).toBe(true);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("settles a command-only prompt through the idle probe without agent events", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      const { events } = collector;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/only an extension command" });
      yield* collector.waitFor(
        (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
      );
      // No agent activity ever arrived: no deltas, no tool items.
      expect(events.some((event) => event.type === "content.delta")).toBe(false);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("does not settle prompt-template slash commands on the first idle snapshot", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      const { events } = collector;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/template an agent prompt" });
      yield* collector.waitFor(
        (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
      );
      expect(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => payloadOf(event).delta)
          .join(""),
      ).toBe("Hello world");
      expect(readLogLines(fixture).filter((line) => line.type === "get_state")).toHaveLength(2);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("hoists $skill chips without settling before their agent activity", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      const { events } = collector;
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "please $research the API" });
      yield* collector.waitFor(
        (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
      );
      const prompts = readLogLines(fixture).filter((line) => line.type === "prompt");
      expect(prompts).toHaveLength(1);
      expect((prompts[0] as { message?: string } | undefined)?.message).toBe(
        "/skill:research please the API",
      );
      expect(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => payloadOf(event).delta)
          .join(""),
      ).toBe("Hello world");
      expect(readLogLines(fixture).filter((line) => line.type === "get_state")).toHaveLength(2);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("preserves native extension UI details and response ids", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "UI_ROUNDTRIP" });

      for (const [method, expectedQuestion, answer] of [
        [
          "select",
          {
            header: "select",
            question: "Choose access",
            options: [
              { label: "Allow", description: "Allow" },
              { label: "Deny", description: "Deny" },
            ],
          },
          "Deny",
        ],
        ["input", { header: "input", question: "Enter a value", options: [] }, "typed value"],
        ["editor", { header: "editor", question: "Edit the value", options: [] }, "edited value"],
      ] as const) {
        const requested = yield* collector.waitFor(
          (event) =>
            event.type === "user-input.requested" && event.payload.questions[0]?.header === method,
        );
        if (requested.type !== "user-input.requested" || requested.requestId === undefined) {
          throw new Error("Expected user input.");
        }
        expect(requested.payload.questions[0]).toMatchObject(expectedQuestion);
        const requestId = ApprovalRequestId.make(requested.requestId);
        yield* adapter.respondToUserInput(THREAD_ID, requestId, { [requestId]: answer });
      }

      const confirm = yield* collector.waitFor(
        (event) =>
          event.type === "request.opened" &&
          event.payload.requestType === "exec_command_approval" &&
          event.payload.detail === "Continue with the extension?",
      );
      if (confirm.type !== "request.opened" || confirm.requestId === undefined) {
        throw new Error("Expected confirmation request.");
      }
      yield* adapter.respondToRequest(
        THREAD_ID,
        ApprovalRequestId.make(confirm.requestId),
        "accept",
      );

      yield* collector.waitFor(
        (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
      );
      const responses = readLogLines(fixture).filter(
        (line) => line.type === "extension_ui_response",
      );
      expect(responses).toEqual([
        { type: "extension_ui_response", id: "ui-select", cancelled: false, value: "Deny" },
        {
          type: "extension_ui_response",
          id: "ui-input",
          cancelled: false,
          value: "typed value",
        },
        {
          type: "extension_ui_response",
          id: "ui-editor",
          cancelled: false,
          value: "edited value",
        },
        { type: "extension_ui_response", id: "ui-confirm", confirmed: true },
      ]);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("keeps stream items isolated across concurrent sessions", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      const { events } = collector;
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
      yield* collector.waitFor(
        (event) => event.type === "item.started" && event.threadId === threadA,
      );
      yield* adapter.sendTurn({ threadId: threadB, input: "fast turn" });
      yield* collector.waitFor(
        (event) =>
          event.type === "turn.completed" &&
          event.threadId === threadB &&
          payloadOf(event).state === "completed",
      );
      yield* adapter.sendTurn({ threadId: threadA, input: "release interleaved turn" });
      yield* collector.waitFor(
        (event) =>
          event.type === "turn.completed" &&
          event.threadId === threadA &&
          payloadOf(event).state === "completed",
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
      const collector = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "REJECT this please" });
      yield* collector.waitFor(
        (event) => event.type === "turn.completed" && payloadOf(event).state === "failed",
      );
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );
});
