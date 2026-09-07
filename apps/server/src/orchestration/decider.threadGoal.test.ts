import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  THREAD_GOAL_LOOP_DEFAULT_MAX_ITERATIONS,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadGoalLoop,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { projectEvent } from "./projector.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Goal thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      voiceNotifications: true,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: UPDATED_AT,
};

/** thread-1 with a goal and a goal loop patched onto the base read model. */
function withLoop(
  patch: Partial<ThreadGoalLoop>,
  goal = "Ship the login fix",
): OrchestrationReadModel {
  const loop: ThreadGoalLoop = {
    kind: "standard",
    state: "idle",
    mode: "native",
    iterations: 0,
    maxIterations: THREAD_GOAL_LOOP_DEFAULT_MAX_ITERATIONS,
    reason: null,
    experiment: null,
    updatedAt: UPDATED_AT,
    ...patch,
  };
  return {
    ...readModel,
    threads: readModel.threads.map((thread) => ({ ...thread, goal, goalLoop: loop })),
  };
}

it.layer(NodeServices.layer)("thread goal decider", (it) => {
  it.effect("creates a thread with the composer's goal and voice choice", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-with-goal"),
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "Draft thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          goal: "Ship the login fix",
          voiceNotifications: false,
          branch: null,
          worktreePath: null,
          createdAt: UPDATED_AT,
        },
        readModel: {
          ...readModel,
          projects: [
            {
              id: ProjectId.make("project-1"),
              title: "Project",
              workspaceRoot: "/tmp/project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: UPDATED_AT,
              updatedAt: UPDATED_AT,
              deletedAt: null,
            },
          ],
        },
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.created");
      if (event.type === "thread.created") {
        expect(event.payload.goal).toBe("Ship the login fix");
        expect(event.payload.voiceNotifications).toBe(false);
      }
    }),
  );

  it.effect("defaults a created thread to no goal and voice notifications on", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-plain"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-1"),
          title: "Draft thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: UPDATED_AT,
        },
        readModel: {
          ...readModel,
          projects: [
            {
              id: ProjectId.make("project-1"),
              title: "Project",
              workspaceRoot: "/tmp/project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: UPDATED_AT,
              updatedAt: UPDATED_AT,
              deletedAt: null,
            },
          ],
        },
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.created");
      if (event.type === "thread.created") {
        expect(event.payload.goal).toBeNull();
        expect(event.payload.voiceNotifications).toBe(true);
      }
    }),
  );

  it.effect("propagates a goal set through thread.meta.update", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-goal-set"),
          threadId: ThreadId.make("thread-1"),
          goal: "Ship the login fix",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.goal).toBe("Ship the login fix");
      }
    }),
  );

  it.effect("serializes a goal clear as null", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-goal-clear"),
          threadId: ThreadId.make("thread-1"),
          goal: null,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect(event.payload.goal).toBeNull();
      }
    }),
  );

  it.effect("omits the goal key when the command does not touch it", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-title-only"),
          threadId: ThreadId.make("thread-1"),
          title: "Renamed",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event.type).toBe("thread.meta-updated");
      if (event.type === "thread.meta-updated") {
        expect("goal" in event.payload).toBe(false);
      }
    }),
  );

  // A recognized T3-local /goal command is thread metadata, never a prompt:
  // whatever client path let it through (persisted outbox, old pending data,
  // remote dispatch), the decider must reject it before any message, turn, or
  // activity event exists for a provider reactor to act on. This also covers
  // the first message of a thread creation: by the time the final turn.start
  // reaches the decider, the thread exists and the same check applies.
  it.effect("rejects a turn whose text is a /goal command", () =>
    Effect.gen(function* () {
      const failure = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-goal-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-goal"),
            role: "user",
            text: "/goal ship it",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: UPDATED_AT,
        },
        readModel,
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
      expect(failure.message).toContain("/goal");
    }),
  );

  it.effect("rejects /goal show and clear turn text as well", () =>
    Effect.gen(function* () {
      for (const text of ["/goal", "/goal clear"]) {
        const failure = yield* decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make(`cmd-goal-turn-${text.length}`),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: MessageId.make("message-goal"),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: UPDATED_AT,
          },
          readModel,
        }).pipe(Effect.flip);

        expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
      }
    }),
  );

  it.effect("still starts an ordinary turn, including one that mentions /goal", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-ordinary-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-ordinary"),
            role: "user",
            text: "what does /goal do here?",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: UPDATED_AT,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("carries a server-authored message origin into the message-sent event", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-origin-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-origin"),
            role: "user",
            text: "continue",
            attachments: [],
            origin: "goal-continue",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: UPDATED_AT,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      const messageSent = events.find((event) => event.type === "thread.message-sent");

      expect(messageSent?.type === "thread.message-sent" && messageSent.payload.origin).toBe(
        "goal-continue",
      );
    }),
  );

  it.effect("starting a goal also starts its loop", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-goal-loop-start"),
          threadId: ThreadId.make("thread-1"),
          goal: "Ship the login fix",
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.meta-updated",
        "thread.goal-loop-updated",
      ]);
      const loopEvent = events[1];
      if (loopEvent?.type === "thread.goal-loop-updated") {
        expect(loopEvent.payload.loop).toMatchObject({
          state: "idle",
          // The thread's provider instance is `codex`, so the loop is native.
          mode: "native",
          iterations: 0,
          maxIterations: THREAD_GOAL_LOOP_DEFAULT_MAX_ITERATIONS,
        });
      }
    }),
  );

  it.effect("accepts the experiment sync immediately after goal activation", () =>
    Effect.gen(function* () {
      const activation = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-experiment-goal-start"),
          threadId: ThreadId.make("thread-1"),
          goal: "Improve the evaluator score",
        },
        readModel,
      });
      let activated = readModel;
      const activationEvents = Array.isArray(activation) ? activation : [activation];
      for (const [index, event] of activationEvents.entries()) {
        activated = yield* projectEvent(activated, { ...event, sequence: index + 1 });
      }

      const synced = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.loop",
          commandId: CommandId.make("cmd-experiment-goal-sync"),
          threadId: ThreadId.make("thread-1"),
          action: "sync",
          state: "idle",
          mode: "native",
          kind: "experiment",
          experiment: {
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
          },
        },
        readModel: activated,
      });
      const event = Array.isArray(synced) ? synced[0] : synced;

      expect(event?.type).toBe("thread.goal-loop-updated");
      if (event?.type === "thread.goal-loop-updated") {
        expect(event.payload.loop).toMatchObject({
          kind: "experiment",
          state: "idle",
          mode: "native",
        });
        const syncedModel = yield* projectEvent(activated, {
          ...event,
          sequence: activationEvents.length + 1,
        });
        const wake = yield* decideOrchestrationCommand({
          command: {
            type: "thread.goal.loop",
            commandId: CommandId.make("cmd-experiment-goal-wake"),
            threadId: ThreadId.make("thread-1"),
            action: "resume",
          },
          readModel: syncedModel,
        });
        const wakeEvent = Array.isArray(wake) ? wake[0] : wake;
        expect(wakeEvent?.type).toBe("thread.goal-loop-updated");
        if (wakeEvent?.type === "thread.goal-loop-updated") {
          expect(wakeEvent.payload.resumed).toBe(true);
          expect(wakeEvent.payload.loop).toMatchObject({ kind: "experiment", state: "idle" });
        }
      }
    }),
  );

  it.effect("clearing the goal clears the loop", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-goal-loop-clear"),
          threadId: ThreadId.make("thread-1"),
          goal: null,
        },
        readModel: withLoop({ state: "running", iterations: 3 }, "Ship the login fix"),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.meta-updated",
        "thread.goal-loop-updated",
      ]);
      const loopEvent = events[1];
      if (loopEvent?.type === "thread.goal-loop-updated") {
        expect(loopEvent.payload.loop).toBeNull();
      }
    }),
  );

  it.effect("replacing the goal keeps the loop but restarts its iterations", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-goal-loop-replace"),
          threadId: ThreadId.make("thread-1"),
          goal: "Ship the logout fix",
        },
        readModel: withLoop({ state: "running", iterations: 4 }, "Ship the login fix"),
      });
      const events = Array.isArray(result) ? result : [result];
      const loopEvent = events[1];

      expect(loopEvent?.type).toBe("thread.goal-loop-updated");
      if (loopEvent?.type === "thread.goal-loop-updated") {
        expect(loopEvent.payload.loop).toMatchObject({ state: "idle", iterations: 0 });
      }
    }),
  );

  it.effect("rejects a loop action on a thread with no goal", () =>
    Effect.gen(function* () {
      const failure = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.loop",
          commandId: CommandId.make("cmd-loop-no-goal"),
          threadId: ThreadId.make("thread-1"),
          action: "continue",
        },
        readModel,
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
      expect(failure.message).toContain("no goal");
    }),
  );

  it.effect("pause, block, and reset move the loop through its states", () =>
    Effect.gen(function* () {
      const cases = [
        { action: "pause", expected: { state: "paused", iterations: 2 } },
        { action: "reset", expected: { state: "idle", iterations: 0 } },
        { action: "complete", expected: { state: "completed", iterations: 2 } },
      ] as const;
      for (const [index, entry] of cases.entries()) {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.goal.loop",
            commandId: CommandId.make(`cmd-loop-${index}`),
            threadId: ThreadId.make("thread-1"),
            action: entry.action,
          },
          readModel: withLoop({ state: "running", iterations: 2 }),
        });
        const event = Array.isArray(result) ? result[0] : result;
        expect(event?.type).toBe("thread.goal-loop-updated");
        if (event?.type === "thread.goal-loop-updated") {
          expect(event.payload.loop).toMatchObject(entry.expected);
        }
      }
    }),
  );

  it.effect("only resume and reset mark the loop as resumed", () =>
    Effect.gen(function* () {
      // The goal loop reactor starts a continuation turn on `resumed` alone,
      // so pausing or blocking must never carry it.
      const cases = [
        { action: "resume", resumed: true },
        { action: "reset", resumed: true },
        { action: "pause", resumed: undefined },
        { action: "block", resumed: undefined },
      ] as const;
      for (const [index, entry] of cases.entries()) {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.goal.loop",
            commandId: CommandId.make(`cmd-loop-resumed-${index}`),
            threadId: ThreadId.make("thread-1"),
            action: entry.action,
          },
          readModel: withLoop({ state: "paused", iterations: 2 }),
        });
        const event = Array.isArray(result) ? result[0] : result;
        if (event?.type === "thread.goal-loop-updated") {
          expect(event.payload.resumed).toBe(entry.resumed);
        }
      }
    }),
  );

  it.effect("block records the reason it was given", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.loop",
          commandId: CommandId.make("cmd-loop-block"),
          threadId: ThreadId.make("thread-1"),
          action: "block",
          reason: "Needs credentials",
        },
        readModel: withLoop({ state: "running", iterations: 2 }),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event?.type).toBe("thread.goal-loop-updated");
      if (event?.type === "thread.goal-loop-updated") {
        expect(event.payload.loop).toMatchObject({
          state: "blocked",
          reason: "Needs credentials",
        });
      }
    }),
  );

  it.effect("continue at the ceiling caps instead of running another iteration", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.loop",
          commandId: CommandId.make("cmd-loop-cap"),
          threadId: ThreadId.make("thread-1"),
          action: "continue",
        },
        readModel: withLoop({ state: "running", iterations: 10, maxIterations: 10 }),
      });
      const event = Array.isArray(result) ? result[0] : result;

      expect(event?.type).toBe("thread.goal-loop-updated");
      if (event?.type === "thread.goal-loop-updated") {
        expect(event.payload.loop).toMatchObject({ state: "capped", iterations: 10 });
      }
    }),
  );

  it.effect("rejects resuming a completed goal", () =>
    Effect.gen(function* () {
      const failure = yield* decideOrchestrationCommand({
        command: {
          type: "thread.goal.loop",
          commandId: CommandId.make("cmd-loop-resume-complete"),
          threadId: ThreadId.make("thread-1"),
          action: "resume",
        },
        readModel: withLoop({ state: "completed", iterations: 3 }),
      }).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(OrchestrationCommandInvariantError);
      expect(failure.message).toContain("already completed");
    }),
  );

  it.effect("a user turn runs the loop without spending an iteration", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-loop-user-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-user"),
            role: "user",
            text: "keep going",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: UPDATED_AT,
        },
        readModel: withLoop({ state: "idle", iterations: 2, mode: "t3" }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
        "thread.goal-loop-updated",
      ]);
      const loopEvent = events[2];
      if (loopEvent?.type === "thread.goal-loop-updated") {
        expect(loopEvent.payload.loop).toMatchObject({ state: "running", iterations: 2 });
      }
    }),
  );

  it.effect("a continuation turn spends an iteration", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-loop-continuation"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-continuation"),
            role: "user",
            text: "Continue working toward the goal.",
            attachments: [],
          },
          continuation: true,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: UPDATED_AT,
        },
        readModel: withLoop({ state: "running", iterations: 2, mode: "t3" }),
      });
      const events = Array.isArray(result) ? result : [result];
      const loopEvent = events[2];

      expect(loopEvent?.type).toBe("thread.goal-loop-updated");
      if (loopEvent?.type === "thread.goal-loop-updated") {
        expect(loopEvent.payload.loop).toMatchObject({ state: "running", iterations: 3 });
      }
    }),
  );

  it.effect("a continuation turn at the ceiling caps instead of starting", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-loop-continuation-capped"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-continuation-capped"),
            role: "user",
            text: "Continue working toward the goal.",
            attachments: [],
          },
          continuation: true,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: UPDATED_AT,
        },
        readModel: withLoop({ state: "running", iterations: 10, maxIterations: 10, mode: "t3" }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual(["thread.goal-loop-updated"]);
      const loopEvent = events[0];
      if (loopEvent?.type === "thread.goal-loop-updated") {
        expect(loopEvent.payload.loop).toMatchObject({ state: "capped" });
      }
    }),
  );

  it.effect("a native-mode loop never drives turns from T3", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-loop-native-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-native"),
            role: "user",
            text: "keep going",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: UPDATED_AT,
        },
        readModel: withLoop({ state: "idle", iterations: 0 }),
      });
      const events = Array.isArray(result) ? result : [result];

      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );
});
