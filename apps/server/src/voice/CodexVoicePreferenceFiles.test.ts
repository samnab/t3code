import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CodexVoicePreferenceFiles from "./CodexVoicePreferenceFiles.ts";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claude");
const projectId = ProjectId.make("project:voice");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const appThread = (
  threadId: ThreadId,
  voiceNotifications: boolean,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "voice",
  providerInstanceId: modelSelection.instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  voiceNotifications,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const providerThread = (
  threadId: ThreadId,
  driver: ProviderDriverKind,
  nativeId: string,
  now: DateTime.Utc,
): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(`provider-thread:${threadId}`),
  driver,
  providerInstanceId: ProviderInstanceId.make(driver),
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId, strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

/** Seeds one app thread plus one provider thread, then hands back the live service. */
const withVoiceFiles = <A, E>(
  input: {
    readonly suffix: string;
    readonly driver: ProviderDriverKind;
    readonly nativeId: string;
    readonly voiceNotifications: boolean;
  },
  body: (context: {
    readonly directory: string;
    readonly apply: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly threadId: ThreadId;
    readonly read: (nativeId: string) => Effect.Effect<string | null>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const service = yield* CodexVoicePreferenceFiles.make;
    const fs = yield* FileSystem.FileSystem;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:voice:${input.suffix}`);

    yield* projections.apply({
      id: EventId.make(`event:voice:${input.suffix}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: appThread(threadId, input.voiceNotifications, now),
    });
    yield* projections.apply({
      id: EventId.make(`event:voice:${input.suffix}:provider-thread`),
      type: "provider-thread.updated",
      threadId,
      driver: input.driver,
      occurredAt: now,
      payload: providerThread(threadId, input.driver, input.nativeId, now),
    });
    yield* service.apply({
      id: EventId.make(`event:voice:${input.suffix}:provider-thread`),
      type: "provider-thread.updated",
      threadId,
      driver: input.driver,
      occurredAt: now,
      payload: providerThread(threadId, input.driver, input.nativeId, now),
    });

    const read = (nativeId: string) =>
      fs
        .readFileString(`${service.directory}/${nativeId}`)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));

    return yield* body({ directory: service.directory, apply: service.apply, threadId, read });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-voice-" }),
      ),
    ),
    Effect.scoped,
  );

it.layer(NodeServices.layer)("codex voice preference files", (it) => {
  it.effect("tracks one Codex thread's preference through toggle and deletion", () =>
    withVoiceFiles(
      { suffix: "codex", driver: codex, nativeId: "0199c0de-beef", voiceNotifications: false },
      ({ apply, threadId, read }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          assert.equal(yield* read("0199c0de-beef"), "0");

          yield* apply({
            id: EventId.make("event:voice:codex:on"),
            type: "thread.voice-notifications-set",
            threadId,
            occurredAt: now,
            payload: { threadId, voiceNotifications: true, updatedAt: now },
          });
          assert.equal(yield* read("0199c0de-beef"), "1");

          yield* apply({
            id: EventId.make("event:voice:codex:deleted"),
            type: "thread.deleted",
            threadId,
            occurredAt: now,
            payload: appThread(threadId, true, now),
          });
          assert.equal(yield* read("0199c0de-beef"), null);
        }),
    ),
  );

  it.effect("writes nothing for a provider that owns its own process", () =>
    withVoiceFiles(
      { suffix: "claude", driver: claude, nativeId: "claude-native", voiceNotifications: false },
      ({ apply, threadId, read }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          assert.equal(yield* read("claude-native"), null);

          yield* apply({
            id: EventId.make("event:voice:claude:on"),
            type: "thread.voice-notifications-set",
            threadId,
            occurredAt: now,
            payload: { threadId, voiceNotifications: true, updatedAt: now },
          });
          assert.equal(yield* read("claude-native"), null);
        }),
    ),
  );

  it.effect("skips a native thread id that is not a plain filename", () =>
    withVoiceFiles(
      { suffix: "escape", driver: codex, nativeId: "../escaped", voiceNotifications: false },
      ({ directory, read }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          assert.equal(yield* read("../escaped"), null);
          assert.deepEqual(
            yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [])),
            [],
          );
        }),
    ),
  );
});
