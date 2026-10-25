import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type KeybindingCommand,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DatabaseStorage from "../../../persistence/DatabaseStorage.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as Settings from "../../../serverSettings.ts";
import * as StorageCleanup from "../../../storageCleanup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

const threadScope = (
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:preferences",
  thread: {
    threadId,
    providerSessionId: "provider:preferences",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
  ...overrides,
});

const environmentLayer = <A, E, R>(
  scope: McpInvocationContext.McpInvocationScope,
  caller: OrchestrationV2ThreadShell,
  settings: Layer.Layer<A, E, R>,
) =>
  McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(caller),
        }),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        settings,
      ),
    ),
  );

const finalResult = <A, E1, R1, E2, R2>(handled: Effect.Effect<Stream.Stream<A, E1, R1>, E2, R2>) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((results) => results.at(-1)),
  );

const countingSettings = (updates: Ref.Ref<number>) =>
  Layer.mock(Settings.ServerSettingsService)({
    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    updateSettings: () =>
      Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
  });

// A fresh service per call rereads settings.json, so each build is a server restart.
const restartedSettings = () =>
  Layer.fresh(Settings.layer).pipe(
    Layer.provide(
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: () => Effect.succeedNone,
          set: () => Effect.void,
          create: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
          remove: () => Effect.void,
        }),
      ),
    ),
  );

const reloadSettings = Effect.flatMap(
  Settings.ServerSettingsService,
  (service) => service.getSettings,
);

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-preferences-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("sidebar auto-settle preferences", (it) => {
  it.effect("reads, writes, and persists them across restarts", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      yield* Effect.flatMap(Settings.ServerSettingsService, (service) =>
        service.updateSettings({
          enableAgentDeviceAccess: true,
          newWorktreesStartFromOrigin: true,
        }),
      ).pipe(Effect.provide(restartedSettings()));

      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const read = yield* finalResult(toolkit.handle("t3_environment_read", {}));
        expect(read?.encodedResult).toMatchObject({
          preferences: {
            newWorktreesStartFromOrigin: true,
            sidebarAutoSettleAfterDays: 3,
            sidebarAutoSettleOnMerge: true,
            sidebarAutoSettleKeepPullRequests: false,
          },
        });
        const disabled = yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            sidebarAutoSettleAfterDays: null,
            sidebarAutoSettleOnMerge: false,
            sidebarAutoSettleKeepPullRequests: true,
          }),
        );
        expect(disabled?.encodedResult).toMatchObject({
          newWorktreesStartFromOrigin: true,
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
          sidebarAutoSettleKeepPullRequests: true,
        });
        const omitted = yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", { defaultThreadEnvMode: "worktree" }),
        );
        expect(omitted?.encodedResult).toMatchObject({
          defaultThreadEnvMode: "worktree",
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
          sidebarAutoSettleKeepPullRequests: true,
        });
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));

      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject({
        enableAgentDeviceAccess: true,
        newWorktreesStartFromOrigin: true,
        defaultThreadEnvMode: "worktree",
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
        sidebarAutoSettleKeepPullRequests: true,
      });

      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            sidebarAutoSettleAfterDays: 7,
            sidebarAutoSettleOnMerge: true,
            sidebarAutoSettleKeepPullRequests: false,
          }),
        );
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));

      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const read = yield* finalResult(toolkit.handle("t3_environment_read", {}));
        expect(read?.encodedResult).toMatchObject({
          preferences: {
            defaultThreadEnvMode: "worktree",
            sidebarAutoSettleAfterDays: 7,
            sidebarAutoSettleOnMerge: true,
            sidebarAutoSettleKeepPullRequests: false,
          },
        });
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject({
        enableAgentDeviceAccess: true,
        newWorktreesStartFromOrigin: true,
      });
    }),
  );
});

it.effect.each([0, 91])("rejects %s auto-settle days before writing", (days) =>
  Effect.gen(function* () {
    const updates = yield* Ref.make(0);
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      return yield* finalResult(
        toolkit.handle("t3_environment_preferences_update", { sidebarAutoSettleAfterDays: days }),
      );
    }).pipe(
      Effect.provide(
        environmentLayer(threadScope(), liveThreadShell(threadId), countingSettings(updates)),
      ),
    );
    expect(result).toMatchObject({ isFailure: true, failureOrigin: "parameters" });
    expect(yield* Ref.get(updates)).toBe(0);
  }),
);

it.effect.each([
  {
    label: "a read-only client",
    scope: threadScope({
      thread: undefined,
      client: { sessionId: "client:preferences", label: "Client", access: "read-only" },
    }),
    caller: liveThreadShell(threadId),
  },
  {
    label: "an approval-required caller",
    scope: threadScope(),
    caller: liveThreadShell(threadId, { runtimeMode: "approval-required" }),
  },
  {
    label: "a plan-mode caller",
    scope: threadScope(),
    caller: liveThreadShell(threadId, { interactionMode: "plan" }),
  },
  {
    label: "another environment's credential",
    scope: threadScope({ environmentId: EnvironmentId.make("environment:other") }),
    caller: liveThreadShell(threadId),
  },
])("denies auto-settle writes from $label", ({ scope, caller }) =>
  Effect.gen(function* () {
    const updates = yield* Ref.make(0);
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      return yield* finalResult(
        toolkit.handle("t3_environment_preferences_update", {
          sidebarAutoSettleAfterDays: null,
          sidebarAutoSettleOnMerge: false,
          sidebarAutoSettleKeepPullRequests: true,
        }),
      );
    }).pipe(Effect.provide(environmentLayer(scope, caller, countingSettings(updates))));
    expect(result?.result).toMatchObject({ code: "capability_denied" });
    expect(yield* Ref.get(updates)).toBe(0);
  }),
);

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-models-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("model preferences", (it) => {
  it.effect("applies each incremental op and persists it across restarts", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      const provider = ProviderInstanceId.make("codex_work");
      const read = Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        return (yield* finalResult(toolkit.handle("t3_environment_read", {})))?.encodedResult;
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));

      yield* Effect.flatMap(Settings.ServerSettingsService, (service) =>
        service.updateSettings({
          favorites: [{ provider, model: "luna" }],
          providerModelPreferences: { [provider]: { hiddenModels: ["astra"], modelOrder: [] } },
        }),
      ).pipe(Effect.provide(restartedSettings()));
      expect(yield* read).toMatchObject({
        preferences: {
          favorites: [{ provider, model: "luna" }],
          providerModelPreferences: {
            [provider]: {
              hiddenModels: ["astra"],
              modelOrder: [],
              defaultModel: null,
              defaultOptions: [],
            },
          },
        },
      });

      const omitted = yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const update = "t3_environment_preferences_update";
        yield* finalResult(
          toolkit.handle(update, {
            setModelFavorites: [
              { provider, model: "sol", favorite: true },
              { provider, model: "luna", favorite: false },
            ],
          }),
        );
        yield* finalResult(
          toolkit.handle(update, { setModelsHidden: [{ provider, model: "nova", hidden: true }] }),
        );
        yield* finalResult(
          toolkit.handle(update, {
            setProviderModelOrder: { provider, modelOrder: ["sol", "luna"] },
          }),
        );
        yield* finalResult(
          toolkit.handle(update, {
            setProviderModelDefault: {
              provider,
              defaultModel: "sol",
              defaultOptions: [{ id: "reasoningEffort", value: "high" }],
            },
          }),
        );
        return yield* finalResult(toolkit.handle(update, { defaultThreadEnvMode: "worktree" }));
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      const expected = {
        favorites: [{ provider, model: "sol" }],
        providerModelPreferences: {
          [provider]: {
            hiddenModels: ["astra", "nova"],
            modelOrder: ["sol", "luna"],
            defaultModel: "sol",
            defaultOptions: [{ id: "reasoningEffort", value: "high" }],
          },
        },
      };
      expect(omitted?.encodedResult).toMatchObject(expected);
      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject(
        expected,
      );
      expect(yield* read).toMatchObject({ preferences: expected });

      yield* Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        yield* finalResult(
          toolkit.handle("t3_environment_preferences_update", {
            setProviderModelDefault: { provider, defaultModel: null },
          }),
        );
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      expect(yield* read).toMatchObject({
        preferences: {
          providerModelPreferences: {
            [provider]: {
              defaultModel: null,
              defaultOptions: [{ id: "reasoningEffort", value: "high" }],
            },
          },
        },
      });
    }),
  );
});

it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-idle-test-" }),
    SqlitePersistence.layerMemory,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("idle compaction and limited-thread snooze", (it) => {
  it.effect("reads the effective mode and keeps the legacy switch consistent", () =>
    Effect.gen(function* () {
      const scope = threadScope();
      const caller = liveThreadShell(threadId);
      const read = Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        return (yield* finalResult(toolkit.handle("t3_environment_read", {})))?.encodedResult;
      }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));
      const update = (
        patch: Pick<
          ServerSettingsPatch,
          "idleCompaction" | "snoozeLimitedThreads" | "defaultThreadEnvMode"
        >,
      ) =>
        Effect.gen(function* () {
          const toolkit = yield* EnvironmentToolkit;
          return yield* finalResult(toolkit.handle("t3_environment_preferences_update", patch));
        }).pipe(Effect.provide(environmentLayer(scope, caller, restartedSettings())));

      // Only the legacy boolean, as written by a client from before modes.
      yield* Effect.flatMap(Settings.ServerSettingsService, (service) =>
        service.updateSettings({ compactIdleThreads: true }),
      ).pipe(Effect.provide(restartedSettings()));
      expect(yield* read).toMatchObject({
        preferences: { idleCompaction: "beforeCacheExpires", snoozeLimitedThreads: false },
      });

      expect(
        (yield* update({ idleCompaction: "off", snoozeLimitedThreads: true }))?.encodedResult,
      ).toMatchObject({ idleCompaction: "off", snoozeLimitedThreads: true });
      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject({
        idleCompaction: "off",
        compactIdleThreads: false,
        snoozeLimitedThreads: true,
      });

      yield* update({ idleCompaction: "beforeCacheExpires" });
      yield* update({ defaultThreadEnvMode: "worktree" });
      expect(yield* reloadSettings.pipe(Effect.provide(restartedSettings()))).toMatchObject({
        idleCompaction: "beforeCacheExpires",
        compactIdleThreads: true,
        snoozeLimitedThreads: true,
      });
      expect(yield* read).toMatchObject({
        preferences: { idleCompaction: "beforeCacheExpires", snoozeLimitedThreads: true },
      });

      yield* update({ snoozeLimitedThreads: false });
      expect(yield* read).toMatchObject({
        preferences: { idleCompaction: "beforeCacheExpires", snoozeLimitedThreads: false },
      });
    }),
  );
});

const staticSettings = Layer.mock(Settings.ServerSettingsService)({
  getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
});

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-environment-keybindings-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
)("keybindings", (it) => {
  // A fresh service per call rereads keybindings.json, so each call is a server restart.
  const provide = <A, E, R>(
    program: Effect.Effect<A, E, R>,
    scope: McpInvocationContext.McpInvocationScope = threadScope(),
  ) =>
    program.pipe(
      Effect.provide(
        environmentLayer(
          scope,
          liveThreadShell(threadId),
          Layer.merge(staticSettings, Layer.fresh(Keybindings.layer)),
        ),
      ),
    );
  const list = provide(
    Effect.flatMap(EnvironmentToolkit, (toolkit) =>
      finalResult(toolkit.handle("t3_keybindings_list", {})),
    ),
  );
  const upsert = (
    params: { readonly key: string; readonly command: KeybindingCommand },
    scope?: McpInvocationContext.McpInvocationScope,
  ) =>
    provide(
      Effect.flatMap(EnvironmentToolkit, (toolkit) =>
        finalResult(toolkit.handle("t3_keybinding_upsert", params)),
      ),
      scope,
    );
  const custom = {
    command: "chat.new",
    shortcut: expect.objectContaining({ key: "9", modKey: true, shiftKey: true }),
  };
  const withCustom = { keybindings: expect.arrayContaining([custom]) };

  it.effect("lists, upserts, and removes custom rules across restarts", () =>
    Effect.gen(function* () {
      const before = yield* list;
      expect(before?.isFailure).toBe(false);
      expect(before?.encodedResult).toMatchObject({ issues: [] });
      expect(before?.encodedResult).not.toMatchObject(withCustom);

      const upserted = yield* upsert({ key: "mod+shift+9", command: "chat.new" });
      expect(upserted?.encodedResult).toMatchObject(withCustom);
      expect((yield* list)?.encodedResult).toMatchObject(withCustom);

      const removed = yield* provide(
        Effect.flatMap(EnvironmentToolkit, (toolkit) =>
          finalResult(
            toolkit.handle("t3_keybinding_remove", { key: "mod+shift+9", command: "chat.new" }),
          ),
        ),
      );
      expect(removed?.encodedResult).not.toMatchObject(withCustom);
      expect((yield* list)?.encodedResult).not.toMatchObject(withCustom);
    }),
  );

  it.effect("rejects a command the keybindings contract does not accept before writing", () =>
    Effect.gen(function* () {
      const before = (yield* list)?.encodedResult;
      const result = yield* upsert({ key: "mod+shift+8", command: "script.Not Valid.run" });
      expect(result).toMatchObject({ isFailure: true, failureOrigin: "parameters" });
      expect((yield* list)?.encodedResult).toEqual(before);
    }),
  );

  it.effect("denies keybinding writes from a read-only client", () =>
    Effect.gen(function* () {
      const result = yield* upsert(
        { key: "mod+shift+7", command: "chat.new" },
        threadScope({
          thread: undefined,
          client: { sessionId: "client:keybindings", label: "Client", access: "read-only" },
        }),
      );
      expect(result?.result).toMatchObject({ code: "capability_denied" });
    }),
  );
});

it.effect("reports storage totals without paths, titles, or commands", () =>
  Effect.gen(function* () {
    const result = yield* Effect.flatMap(EnvironmentToolkit, (toolkit) =>
      finalResult(toolkit.handle("t3_environment_storage_report", {})),
    ).pipe(
      Effect.provide(
        environmentLayer(
          threadScope(),
          liveThreadShell(threadId),
          Layer.mergeAll(
            staticSettings,
            Layer.mock(StorageCleanup.StorageCleanup)({
              latestReport: Effect.succeed({
                trigger: "automatic",
                startedAt: "2026-10-25T00:00:00.000Z",
                finishedAt: "2026-10-25T00:00:01.000Z",
                entries: [
                  {
                    kind: "worktree",
                    outcome: "removed",
                    reason: "merged",
                    path: "/secret/worktree",
                    projectPath: "/secret/project",
                    threadId,
                    threadTitle: "Private title",
                    bytes: 10,
                    files: 1,
                  },
                ],
                counts: { removed: 1, kept: 0, failed: 0 },
                omittedCount: 4,
                bytesFreed: 10,
              }),
            }),
            Layer.mock(DatabaseStorage.DatabaseStorage)({
              status: Stream.make({
                databaseBytes: 3 * 1024 ** 3,
                reclaimableBytes: 2 * 1024 ** 3,
                incrementalVacuumEnabled: false,
                compactCommand: "t3 doctor --base-dir /secret/home",
              }),
            }),
          ),
        ),
      ),
    );
    expect(result?.encodedResult).toEqual({
      database: {
        databaseBytes: 3 * 1024 ** 3,
        reclaimableBytes: 2 * 1024 ** 3,
        incrementalVacuumEnabled: false,
        compactionRecommended: true,
      },
      lastCleanup: {
        trigger: "automatic",
        startedAt: "2026-10-25T00:00:00.000Z",
        finishedAt: "2026-10-25T00:00:01.000Z",
        counts: { removed: 1, kept: 0, failed: 0 },
        bytesFreed: 10,
        entryCount: 5,
      },
    });
  }),
);
