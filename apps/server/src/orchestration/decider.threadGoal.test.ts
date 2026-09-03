import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

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
});
