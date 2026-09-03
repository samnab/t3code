import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(input?: {
  readonly archivedAt?: string | null;
  readonly session?: OrchestrationSession | null;
  readonly activities?: OrchestrationThread["activities"];
  readonly messages?: OrchestrationThread["messages"];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "zai/glm-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        voiceNotifications: true,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input?.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: input?.messages ?? [],
        proposedPlans: [],
        activities: input?.activities ?? [],
        checkpoints: [],
        session: input?.session ?? null,
      },
    ],
    updatedAt: NOW,
  };
}

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Pi",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

const compactCommand = {
  type: "thread.context.compact",
  commandId: CommandId.make("cmd-compact-1"),
  threadId: ThreadId.make("thread-1"),
  createdAt: NOW,
} as const;

it.layer(NodeServices.layer)("thread.context.compact decider", (it) => {
  it.effect("emits a compact-requested event for an idle thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: compactCommand,
        readModel: makeReadModel({ session: makeSession("ready") }),
      });
      const event = Array.isArray(result) ? result[0] : result;
      if (event.type !== "thread.context-compact-requested") {
        throw new Error(`unexpected event type ${event.type}`);
      }
      expect(String(event.commandId)).toBe("cmd-compact-1");
      expect(String(event.payload.threadId)).toBe("thread-1");
    }),
  );

  it.effect("rejects unknown threads", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel();
      const result = yield* decideOrchestrationCommand({
        command: { ...compactCommand, threadId: ThreadId.make("thread-missing") },
        readModel,
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects archived threads", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: compactCommand,
        readModel: makeReadModel({
          archivedAt: NOW,
          session: makeSession("ready"),
        }),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects running and starting sessions", () =>
    Effect.gen(function* () {
      for (const status of ["running", "starting"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: compactCommand,
          readModel: makeReadModel({ session: makeSession(status) }),
        }).pipe(Effect.flip);
        expect(result._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );

  it.effect("rejects threads with an open approval or user-input request", () =>
    Effect.gen(function* () {
      const requestId = EventId.make("req-1");
      const result = yield* decideOrchestrationCommand({
        command: compactCommand,
        readModel: makeReadModel({
          session: makeSession("ready"),
          activities: [
            {
              id: EventId.make("activity-1"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Approve command",
              payload: { requestId },
              turnId: null,
              createdAt: NOW,
            },
          ],
        }),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a queued turn start inside the adoption window", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: compactCommand,
        readModel: makeReadModel({
          session: makeSession("ready"),
          messages: [
            {
              id: MessageId.make("msg-1"),
              role: "user",
              text: "hello",
              attachments: [],
              turnId: null,
              streaming: false,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      }).pipe(Effect.flip);
      expect(result._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
