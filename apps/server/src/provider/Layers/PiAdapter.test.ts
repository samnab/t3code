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
  RuntimeTaskId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { decodeControlEnvelope } from "../PiSubagentControl.ts";
import type {
  ProviderAdapterShape,
  ProviderSubagentControlPlaneShape,
} from "../Services/ProviderAdapter.ts";
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
  delete process.env.FAKE_PI_COMPACT;
  delete process.env.FAKE_PI_FAIL_COMMAND;
  delete process.env.FAKE_PI_VETO;
  delete process.env.FAKE_PI_MANAGER;
  delete process.env.FAKE_PI_MANAGER_ID;
  delete process.env.FAKE_PI_MANAGER_CAPABILITIES;
  delete process.env.FAKE_PI_MANAGER_CAPABILITIES_FILE;
  delete process.env.FAKE_PI_MANAGER_REMOVED_FILE;
  delete process.env.FAKE_PI_MANAGER_PRENEGOTIATION_UPSERTS;
  delete process.env.FAKE_PI_MANAGER_REJECT_FILE;
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

  it.live("projects manager-owned subagent lifecycle through task events", () =>
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

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "SUBAGENT_LIFECYCLE",
      });
      const started = yield* collector.waitFor((event) => event.type === "task.started");
      if (started.type !== "task.started") {
        throw new Error("Expected managed subagent start.");
      }
      const taskId = started.payload.taskId;
      const completed = yield* collector.waitFor(
        (event) => event.type === "task.completed" && event.payload.taskId === taskId,
      );
      if (completed.type !== "task.completed") {
        throw new Error("Expected managed subagent completion.");
      }

      expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
      expect(taskId).not.toContain("sa-1");
      expect(started.turnId).toBe(turn.turnId);
      expect(started.payload).toMatchObject({
        taskId,
        taskType: "subagent",
        title: "map auth",
        role: "pi",
        model: "zai/glm-5.3-flash",
        toolUseId: "spawn-1",
        runHandles: { runId: taskId },
        timelineBypass: true,
        subagentRun: {
          runId: taskId,
          runtimeFamily: "pi-stock",
          nativeRunId: "sa-1",
          status: "active",
          historyAvailability: "summary-only",
        },
      });
      expect(completed.turnId).toBeUndefined();
      expect(completed.payload).toMatchObject({
        taskId,
        status: "completed",
        summary: "Mapped the auth flow.",
        taskType: "subagent",
        title: "map auth",
        role: "pi",
        model: "zai/glm-5.3-flash",
        toolUseId: "spawn-1",
        runHandles: { runId: taskId },
        timelineBypass: true,
        subagentRun: {
          runId: taskId,
          nativeRunId: "sa-1",
          status: "done",
          terminalReason: "native-completed",
        },
      });
      expect(
        collector.events.filter(
          (event) => event.type === "task.completed" && event.payload.taskId === taskId,
        ),
      ).toHaveLength(1);
      expect(
        collector.events.some(
          (event) =>
            (event.type === "task.started" || event.type === "task.completed") &&
            event.payload.taskId.endsWith(":forged"),
        ),
      ).toBe(false);

      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("completes consumed wait and cancel results with authoritative status", () =>
    Effect.gen(function* () {
      for (const [input, expectedStatus] of [
        ["SUBAGENT_WAIT_CONSUMED", "completed"],
        ["SUBAGENT_WAIT_ERROR_CONSUMED", "failed"],
        ["SUBAGENT_CANCEL_CONSUMED", "failed"],
      ] as const) {
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
        yield* adapter.sendTurn({ threadId: THREAD_ID, input });
        const started = yield* collector.waitFor((event) => event.type === "task.started");
        if (started.type !== "task.started") throw new Error("Expected task start.");
        const completed = yield* collector.waitFor(
          (event) =>
            event.type === "task.completed" && event.payload.taskId === started.payload.taskId,
        );
        if (completed.type !== "task.completed") throw new Error("Expected task completion.");
        expect(completed.payload.status).toBe(expectedStatus);
        expect(completed.payload.summary).toBeUndefined();
        yield* adapter.stopSession(THREAD_ID);
      }
    }).pipe(provideTestEnv),
  );

  it.live("bounds oversized manager results by Unicode code point before completing", () =>
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
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_OVERSIZED" });
      const completed = yield* collector.waitFor((event) => event.type === "task.completed");
      if (completed.type !== "task.completed") throw new Error("Expected task completion.");
      const summary = completed.payload.summary ?? "";
      expect(Array.from(summary)).toHaveLength(4_096);
      expect(summary.endsWith("x")).toBe(true);
      expect(summary).not.toContain("�");
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("reconciles a terminal result that arrives before spawn registration", () =>
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
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_TERMINAL_RACE" });
      const completed = yield* collector.waitFor((event) => event.type === "task.completed");
      const started = collector.events.find((event) => event.type === "task.started");
      expect(started?.type).toBe("task.started");
      if (started?.type !== "task.started" || completed.type !== "task.completed") {
        throw new Error("Expected reconciled task lifecycle.");
      }
      expect(completed.payload.taskId).toBe(started.payload.taskId);
      expect(completed.payload.summary).toBe("Won the registration race.");
      expect(collector.events.filter((event) => event.type === "task.completed")).toHaveLength(1);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("terminalizes non-running spawn snapshots immediately", () =>
    Effect.gen(function* () {
      for (const [input, expectedStatus] of [
        ["SUBAGENT_SPAWN_DONE", "completed"],
        ["SUBAGENT_SPAWN_ERROR", "failed"],
      ] as const) {
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
        yield* adapter.sendTurn({ threadId: THREAD_ID, input });
        const started = yield* collector.waitFor((event) => event.type === "task.started");
        if (started.type !== "task.started") throw new Error("Expected task start.");
        const completed = yield* collector.waitFor(
          (event) =>
            event.type === "task.completed" && event.payload.taskId === started.payload.taskId,
        );
        if (completed.type !== "task.completed") throw new Error("Expected task completion.");
        expect(completed.payload.status).toBe(expectedStatus);
        yield* adapter.stopSession(THREAD_ID);
      }
    }).pipe(provideTestEnv),
  );

  it.live("maps a known native parent to the current opaque parent run only", () =>
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

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_NESTED" });
      const startedByNative = (nativeRunId: string) =>
        collector.waitFor(
          (event) =>
            event.type === "task.started" && event.payload.subagentRun?.nativeRunId === nativeRunId,
        );
      const root = yield* startedByNative("sa-1");
      const nested = yield* startedByNative("sa-2");
      const orphan = yield* startedByNative("sa-3");
      if (
        root.type !== "task.started" ||
        nested.type !== "task.started" ||
        orphan.type !== "task.started"
      ) {
        throw new Error("Expected three nested subagent starts.");
      }

      expect(root.payload.parentAgentId).toBeUndefined();
      expect(root.payload.subagentRun?.parentRunId).toBeUndefined();
      expect(nested.payload.parentAgentId).toBe(root.payload.taskId);
      expect(nested.payload.subagentRun?.parentRunId).toBe(root.payload.taskId);
      expect(orphan.payload.parentAgentId).toBeUndefined();
      expect(orphan.payload.subagentRun?.parentRunId).toBeUndefined();
      for (const started of [root, nested, orphan]) {
        expect(started.payload.taskId).toMatch(/^[0-9a-f-]{36}$/);
      }
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("mints opaque ids when a fresh Pi process reuses a native id", () =>
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
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_LIFECYCLE" });
      const first = yield* collector.waitFor((event) => event.type === "task.started");
      if (first.type !== "task.started") throw new Error("Expected first task start.");
      yield* collector.waitFor(
        (event) => event.type === "task.completed" && event.payload.taskId === first.payload.taskId,
      );
      yield* adapter.stopSession(THREAD_ID);

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_LIFECYCLE" });
      const second = yield* collector.waitFor(
        (event) => event.type === "task.started" && event.payload.taskId !== first.payload.taskId,
      );
      if (second.type !== "task.started") throw new Error("Expected second task start.");
      expect(first.payload.subagentRun?.nativeRunId).toBe("sa-1");
      expect(second.payload.subagentRun?.nativeRunId).toBe("sa-1");
      expect(second.payload.subagentRun?.ownerEpoch).not.toBe(
        first.payload.subagentRun?.ownerEpoch,
      );
      expect(second.payload.taskId).not.toBe(first.payload.taskId);
      expect(first.payload.taskId).not.toContain("sa-1");
      expect(second.payload.taskId).not.toContain("sa-1");
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("stops live managed children before closing their Pi process", () =>
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
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_STAYS_RUNNING" });
      const started = yield* collector.waitFor((event) => event.type === "task.started");
      if (started.type !== "task.started") throw new Error("Expected task start.");
      yield* adapter.stopSession(THREAD_ID);
      const completed = yield* collector.waitFor(
        (event) =>
          event.type === "task.completed" && event.payload.taskId === started.payload.taskId,
      );
      if (completed.type !== "task.completed") throw new Error("Expected task completion.");
      expect(completed.payload.status).toBe("stopped");
      expect(yield* adapter.hasSession(THREAD_ID)).toBe(false);
    }).pipe(provideTestEnv),
  );

  it.live("stops live managed children before replacing their Pi process", () =>
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
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_STAYS_RUNNING" });
      const started = yield* collector.waitFor((event) => event.type === "task.started");
      if (started.type !== "task.started") throw new Error("Expected task start.");
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      const completed = yield* collector.waitFor(
        (event) =>
          event.type === "task.completed" && event.payload.taskId === started.payload.taskId,
      );
      if (completed.type !== "task.completed") throw new Error("Expected task completion.");
      expect(completed.payload.status).toBe("stopped");
      expect(yield* adapter.hasSession(THREAD_ID)).toBe(true);
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

  const requireControlPlane = (
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ): ProviderSubagentControlPlaneShape<ProviderAdapterError> => {
    const plane = adapter.subagentControlPlane;
    if (plane === undefined) throw new Error("expected a Pi subagent control plane");
    return plane;
  };

  const controlEnvelopes = (fixture: Fixture) =>
    readLogLines(fixture)
      .filter(
        (line) =>
          line["type"] === "prompt" &&
          String(line["message"] ?? "").startsWith("/subagent:t3-control "),
      )
      .map((line) => decodeControlEnvelope(String(line["message"]).split(" ")[1] ?? ""))
      .filter((envelope) => envelope !== undefined);

  it.live(
    "reports an explicit unsupported status and never sends the manager command when it is not registered",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        const adapter = yield* makeTestAdapter(
          decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
        );
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: PROVIDER,
          runtimeMode: "full-access",
        });
        const statuses = yield* requireControlPlane(adapter).status();
        expect(statuses).toHaveLength(1);
        const status = statuses[0];
        expect(status?.supported).toBe(false);
        expect(status?.reason).toContain("not registered");
        expect(status?.controls.steer.enabled).toBe(false);
        expect(status?.controls.cancel.enabled).toBe(false);
        // The control command must never reach the model as a prompt.
        expect(controlEnvelopes(fixture)).toHaveLength(0);
        yield* adapter.stopSession(THREAD_ID);
      }).pipe(provideTestEnv),
  );

  it.live("negotiates declared capabilities and derives per-control availability", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      process.env.FAKE_PI_MANAGER = "1";
      process.env.FAKE_PI_MANAGER_CAPABILITIES =
        '{"deliveryAcknowledgements":false,"stableActivations":false}';
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      const statuses = yield* requireControlPlane(adapter).status();
      expect(statuses).toHaveLength(1);
      const status = statuses[0];
      expect(status?.supported).toBe(true);
      expect(status?.managerId).toBe("fake-manager-1");
      expect(status?.protocolVersion).toBe(1);
      expect(status?.capabilities).toMatchObject({
        deliveryAcknowledgements: false,
        stableActivations: false,
        steering: true,
        cancellation: true,
      });
      expect(status?.controls.steer).toMatchObject({ enabled: false });
      expect(status?.controls.cancel).toMatchObject({ enabled: false });
      if (!status?.controls.steer.enabled) {
        expect(status?.controls.steer.reason).toContain("deliveryAcknowledgements");
      }
      if (!status?.controls.cancel.enabled) {
        expect(status?.controls.cancel.reason).toContain("deliveryAcknowledgements");
      }
      // Exactly one negotiation envelope was sent, by registration only.
      const envelopes = controlEnvelopes(fixture);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({ v: 1, op: "negotiate" });
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live(
    "projects normalized manager runs into task rows idempotently and rejects stale events",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        process.env.FAKE_PI_MANAGER = "1";
        const adapter = yield* makeTestAdapter(
          decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
        );
        const collector = yield* collectEvents(adapter.streamEvents);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: PROVIDER,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "MANAGER_RUN_LIFECYCLE" });
        yield* collector.waitFor(
          (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
        );
        const taskEvents = collector.events.filter(
          (event) =>
            event.type === "task.started" ||
            event.type === "task.updated" ||
            event.type === "task.completed",
        );
        const payloadOfTask = (event: ProviderRuntimeEvent) =>
          event.payload as {
            taskId?: string;
            description?: string;
            status?: string;
            summary?: string;
            taskType?: string;
            role?: string;
            subagentRun?: {
              runId: string;
              nativeRunId?: string;
              activationId?: string;
              status: string;
              terminalReason?: string;
            };
          };
        const starts = taskEvents.filter((event) => event.type === "task.started");
        expect(starts).toHaveLength(3);
        expect(payloadOfTask(starts[0]!)).toMatchObject({
          description: "map auth",
          taskType: "subagent",
          role: "pi",
        });
        expect(starts.map((event) => payloadOfTask(event).taskId)).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^[0-9a-f-]{36}$/),
            expect.stringMatching(/^[0-9a-f-]{36}$/),
            expect.stringMatching(/^[0-9a-f-]{36}$/),
          ]),
        );
        expect(starts.map((event) => payloadOfTask(event).subagentRun?.activationId)).toEqual([
          "act-1",
          "act-2",
          "act-3",
        ]);
        const updates = taskEvents.filter((event) => event.type === "task.updated");
        expect(updates).toHaveLength(1);
        expect(payloadOfTask(updates[0]!)).toMatchObject({ status: "running" });
        const completions = taskEvents.filter((event) => event.type === "task.completed");
        expect(completions).toHaveLength(2);
        expect(payloadOfTask(completions[0]!)).toMatchObject({
          status: "completed",
          summary: "Mapped the auth flow.",
        });
        // Supersession: the replaced activation's row is stopped before the
        // replacement activation starts.
        const supersededIndex = taskEvents.findIndex(
          (event) =>
            event.type === "task.completed" &&
            payloadOfTask(event).subagentRun?.activationId === "act-2",
        );
        const replacementIndex = taskEvents.findIndex(
          (event) =>
            event.type === "task.started" &&
            payloadOfTask(event).subagentRun?.activationId === "act-3",
        );
        expect(supersededIndex).toBeGreaterThanOrEqual(0);
        expect(replacementIndex).toBeGreaterThan(supersededIndex);
        expect(payloadOfTask(taskEvents[supersededIndex]!)).toMatchObject({ status: "stopped" });
        // Stale, duplicate-terminal, late-activation, and wrong-owner records
        // produced no rows at all.
        expect(
          taskEvents.some((event) => payloadOfTask(event).subagentRun?.nativeRunId === "sa-9"),
        ).toBe(false);
        // Stopping the session finalizes the still-open third activation.
        yield* adapter.stopSession(THREAD_ID);
        const stopped = collector.events.filter(
          (event) =>
            event.type === "task.completed" &&
            (event.payload as { subagentRun?: { activationId?: string } }).subagentRun
              ?.activationId === "act-3",
        );
        expect(stopped).toHaveLength(1);
        expect((stopped[0]!.payload as { status?: string }).status).toBe("stopped");
      }).pipe(provideTestEnv),
  );

  it.live(
    "keeps the tool-result fallback and a supported status when normalized events are absent",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        process.env.FAKE_PI_MANAGER = "1";
        process.env.FAKE_PI_MANAGER_CAPABILITIES = '{"normalizedEvents":false,"steering":false}';
        const adapter = yield* makeTestAdapter(
          decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
        );
        const collector = yield* collectEvents(adapter.streamEvents);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: PROVIDER,
          runtimeMode: "full-access",
        });

        // The negotiated protocol is valid, so status stays supported; the
        // declared capabilities are exposed verbatim, but controls require
        // normalized lifecycle events.
        const statuses = yield* requireControlPlane(adapter).status();
        const status = statuses[0];
        expect(status?.supported).toBe(true);
        expect(status?.managerId).toBe("fake-manager-1");
        expect(status?.capabilities).toMatchObject({
          normalizedEvents: false,
          steering: false,
          cancellation: true,
        });
        expect(status?.controls.steer.enabled).toBe(false);
        expect(status?.controls.cancel.enabled).toBe(false);
        if (!status?.controls.steer.enabled) {
          expect(status?.controls.steer.reason).toContain("normalizedEvents");
        }
        if (!status?.controls.cancel.enabled) {
          expect(status?.controls.cancel.reason).toContain("normalizedEvents");
        }

        // The pre-existing tool-result projection still owns the lifecycle.
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_LIFECYCLE" });
        const started = yield* collector.waitFor((event) => event.type === "task.started");
        if (started.type !== "task.started") throw new Error("Expected fallback task start.");
        const completed = yield* collector.waitFor(
          (event) =>
            event.type === "task.completed" && event.payload.taskId === started.payload.taskId,
        );
        if (completed.type !== "task.completed") throw new Error("Expected fallback completion.");
        expect(started.payload.taskId).toMatch(/^[0-9a-f-]{36}$/);
        expect(started.payload.taskId).not.toContain("sa-1");
        expect(started.payload.subagentRun).toMatchObject({
          runtimeFamily: "pi-stock",
          nativeRunId: "sa-1",
          status: "active",
        });
        expect(completed.payload.status).toBe("completed");
        expect(completed.payload.summary).toBe("Mapped the auth flow.");

        // Manager run-upserts must not project any rows of their own.
        const tasksBefore = collector.events.filter((event) =>
          event.type.startsWith("task."),
        ).length;
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "MANAGER_RUN_LIFECYCLE" });
        yield* collector.waitFor(
          (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
        );
        expect(collector.events.filter((event) => event.type.startsWith("task.")).length).toBe(
          tasksBefore,
        );
        yield* adapter.stopSession(THREAD_ID);
      }).pipe(provideTestEnv),
  );

  it.live("buffers and replays only the newest pre-negotiation restore records", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      process.env.FAKE_PI_MANAGER = "1";
      process.env.FAKE_PI_MANAGER_PRENEGOTIATION_UPSERTS = "65";
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* collector.waitFor((event) => event.type === "session.started");
      const restoredStarts = collector.events.filter(
        (event) =>
          event.type === "task.started" &&
          (event.payload as { description?: string }).description?.startsWith("restored run "),
      );
      expect(restoredStarts).toHaveLength(64);
      expect(
        restoredStarts.some(
          (event) => (event.payload as { description?: string }).description === "restored run 1",
        ),
      ).toBe(false);
      expect(
        restoredStarts.some(
          (event) => (event.payload as { description?: string }).description === "restored run 65",
        ),
      ).toBe(true);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("stops an evicted manager row once and excludes it from the stop sweep", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      process.env.FAKE_PI_MANAGER = "1";
      process.env.FAKE_PI_MANAGER_PRENEGOTIATION_UPSERTS = "51";
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* collector.waitFor((event) => event.type === "session.started");
      const firstCompletion = collector.events.find(
        (event) =>
          event.type === "task.completed" &&
          event.payload.subagentRun?.nativeRunId === "restore-1" &&
          event.payload.subagentRun.activationId === "restore-act-1",
      );
      if (firstCompletion?.type !== "task.completed") {
        throw new Error("Expected the evicted manager run to stop.");
      }
      const firstTaskCompletions = () =>
        collector.events.filter(
          (event) =>
            event.type === "task.completed" &&
            event.payload.taskId === firstCompletion.payload.taskId,
        );
      expect(firstTaskCompletions()).toHaveLength(1);
      expect(firstCompletion.payload.status).toBe("stopped");
      yield* adapter.stopSession(THREAD_ID);
      expect(firstTaskCompletions()).toHaveLength(1);
      expect(collector.events.filter((event) => event.type === "task.completed")).toHaveLength(51);
    }).pipe(provideTestEnv),
  );

  it.live("does not duplicate task rows when manager events and tool events arrive together", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      process.env.FAKE_PI_MANAGER = "1";
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "SUBAGENT_TOOL_AND_MANAGER" });
      yield* collector.waitFor(
        (event) => event.type === "turn.completed" && payloadOf(event).state === "completed",
      );
      const started = collector.events.filter((event) => event.type === "task.started");
      expect(started).toHaveLength(1);
      expect((started[0]!.payload as { taskId?: string }).taskId).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        (
          started[0]!.payload as {
            subagentRun?: { nativeRunId?: string; activationId?: string };
          }
        ).subagentRun,
      ).toMatchObject({ nativeRunId: "sa-1", activationId: "act-1" });
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live(
    "routes owner steer/cancel with correlated envelopes and rejects mismatched managers",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        process.env.FAKE_PI_MANAGER = "1";
        // The fake inherits this path at spawn; creating/removing the file is
        // what toggles rejection while the child is running.
        const rejectFile = NodePath.join(NodePath.dirname(fixture.logPath), "reject");
        process.env.FAKE_PI_MANAGER_REJECT_FILE = rejectFile;
        const adapter = yield* makeTestAdapter(
          decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
        );
        const collector = yield* collectEvents(adapter.streamEvents);
        yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: PROVIDER,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: THREAD_ID, input: "MANAGER_RUN_OPEN" });
        const started = yield* collector.waitFor((event) => event.type === "task.started");
        const taskId = RuntimeTaskId.make((started.payload as { taskId: string }).taskId);
        const plane = requireControlPlane(adapter);
        const promptsBeforeMismatch = controlEnvelopes(fixture).length;

        // Another manager id is refused without any prompt leaving the process.
        const mismatch = yield* Effect.flip(
          plane.steer({ managerId: "other-manager", runId: taskId, text: "hello" }),
        );
        expect(mismatch._tag).toBe("SubagentControlError");
        if (mismatch._tag === "SubagentControlError") {
          expect(mismatch.reason).toBe("manager-mismatch");
        }
        expect(controlEnvelopes(fixture)).toHaveLength(promptsBeforeMismatch);

        // Untracked run ids fail explicitly.
        const unknownRun = yield* Effect.flip(
          plane.cancel({
            managerId: "fake-manager-1",
            runId: RuntimeTaskId.make("pi:other-epoch:act-x:sa-x"),
          }),
        );
        if (unknownRun._tag === "SubagentControlError") {
          expect(unknownRun.reason).toBe("unknown-run");
        }

        const steer = yield* plane.steer({
          managerId: "fake-manager-1",
          runId: taskId,
          text: "focus on auth",
        });
        expect(steer).toEqual({ accepted: true });
        const cancel = yield* plane.cancel({ managerId: "fake-manager-1", runId: taskId });
        expect(cancel).toEqual({ accepted: true });
        const envelopes = controlEnvelopes(fixture);
        expect(envelopes).toHaveLength(promptsBeforeMismatch + 4);
        expect(envelopes.at(-4)).toMatchObject({ v: 1, op: "negotiate" });
        expect(envelopes.at(-3)).toMatchObject({
          v: 1,
          op: "steer",
          managerId: "fake-manager-1",
          runId: "sa-1",
          activationId: "act-1",
          text: "focus on auth",
        });
        expect(envelopes.at(-2)).toMatchObject({ v: 1, op: "negotiate" });
        expect(envelopes.at(-1)).toMatchObject({
          v: 1,
          op: "cancel",
          managerId: "fake-manager-1",
          runId: "sa-1",
          activationId: "act-1",
        });

        // A manager that refuses the command surfaces as manager-rejected.
        NodeFS.writeFileSync(rejectFile, "reject");
        const rejected = yield* Effect.flip(
          plane.steer({ managerId: "fake-manager-1", runId: taskId, text: "again" }),
        );
        if (rejected._tag === "SubagentControlError") {
          expect(rejected.reason).toBe("manager-rejected");
          expect(rejected.detail).toContain("refused");
        }
        NodeFS.rmSync(rejectFile);
        delete process.env.FAKE_PI_MANAGER_REJECT_FILE;
        yield* adapter.stopSession(THREAD_ID);
      }).pipe(provideTestEnv),
  );

  it.live("re-checks live capabilities before sending a control command", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      process.env.FAKE_PI_MANAGER = "1";
      const capabilitiesFile = NodePath.join(
        NodePath.dirname(fixture.logPath),
        "capabilities.json",
      );
      process.env.FAKE_PI_MANAGER_CAPABILITIES_FILE = capabilitiesFile;
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "MANAGER_RUN_OPEN" });
      const started = yield* collector.waitFor((event) => event.type === "task.started");
      const taskId = RuntimeTaskId.make((started.payload as { taskId: string }).taskId);
      NodeFS.writeFileSync(capabilitiesFile, '{"steering":false}');
      const before = controlEnvelopes(fixture).length;
      const rejected = yield* Effect.flip(
        requireControlPlane(adapter).steer({
          managerId: "fake-manager-1",
          runId: taskId,
          text: "do not send this",
        }),
      );
      if (rejected._tag === "SubagentControlError") {
        expect(rejected.reason).toBe("control-disabled");
        expect(rejected.detail).toContain("steering");
      }
      const added = controlEnvelopes(fixture).slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ op: "negotiate" });
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("never prompts when the manager command disappears before control send", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      process.env.FAKE_PI_MANAGER = "1";
      const removedFile = NodePath.join(NodePath.dirname(fixture.logPath), "manager-removed");
      process.env.FAKE_PI_MANAGER_REMOVED_FILE = removedFile;
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      const collector = yield* collectEvents(adapter.streamEvents);
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "MANAGER_RUN_OPEN" });
      const started = yield* collector.waitFor((event) => event.type === "task.started");
      const taskId = RuntimeTaskId.make((started.payload as { taskId: string }).taskId);
      NodeFS.writeFileSync(removedFile, "removed");
      const before = controlEnvelopes(fixture).length;
      const unsupported = yield* Effect.flip(
        requireControlPlane(adapter).cancel({ managerId: "fake-manager-1", runId: taskId }),
      );
      if (unsupported._tag === "SubagentControlError") {
        expect(unsupported.reason).toBe("unsupported");
        expect(unsupported.detail).toContain("not registered");
      }
      expect(controlEnvelopes(fixture)).toHaveLength(before);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );
});

describe("PiAdapter compaction", () => {
  it.live("maps a manual compact into the canonical lifecycle without storing the summary", () =>
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

      yield* adapter.compactContext?.(THREAD_ID);

      const itemStarted = yield* collector.waitFor(
        (event) => event.type === "item.started" && event.payload.itemType === "context_compaction",
      );
      const itemCompleted = yield* collector.waitFor(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "context_compaction",
      );
      const stateChanged = yield* collector.waitFor(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      expect((itemStarted.payload as { status?: string }).status).toBe("inProgress");
      expect((itemCompleted.payload as { status?: string }).status).toBe("completed");
      // Only the lifecycle and a reason travel into T3 — never the summary.
      const compactedDetail = (
        stateChanged.payload as { detail?: { reason?: string; summary?: string } }
      ).detail;
      expect(compactedDetail?.reason).toBe("manual");
      expect(compactedDetail?.summary).toBeUndefined();
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("refuses to compact while a turn is active", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const adapter = yield* makeTestAdapter(
        decodePiSettings({ enabled: true, binaryPath: fixture.binaryPath }),
      );
      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "WAIT_FOR_ABORT" });

      const blocked = yield* adapter.compactContext?.(THREAD_ID).pipe(Effect.flip);
      expect(blocked?._tag).toBe("ProviderAdapterRequestError");
      if (blocked?._tag === "ProviderAdapterRequestError") {
        expect(blocked.detail).toContain("cannot start while a turn is running");
      }
      yield* adapter.interruptTurn(THREAD_ID);
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );

  it.live("fails truthfully when compaction errors and never reports compacted state", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      process.env.FAKE_PI_COMPACT = "fail";
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

      const failure = yield* adapter.compactContext?.(THREAD_ID).pipe(Effect.flip);
      expect(failure?._tag).toBe("ProviderAdapterProcessError");
      yield* collector.waitFor(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "context_compaction",
      );
      expect(
        events.some(
          (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
        ),
      ).toBe(false);
      yield* adapter.stopSession(THREAD_ID);
      delete process.env.FAKE_PI_COMPACT;
    }).pipe(provideTestEnv),
  );

  it.live("observes automatic threshold compaction inside a running turn", () =>
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

      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "AUTO_COMPACT" });
      const stateChanged = yield* collector.waitFor(
        (event) => event.type === "thread.state.changed" && event.payload.state === "compacted",
      );
      const turnCompleted = yield* collector.waitFor((event) => event.type === "turn.completed");
      expect((turnCompleted.payload as { state?: string }).state).toBe("completed");
      expect((stateChanged.payload as { detail?: { reason?: string } }).detail?.reason).toBe(
        "threshold",
      );
      yield* adapter.stopSession(THREAD_ID);
    }).pipe(provideTestEnv),
  );
});
