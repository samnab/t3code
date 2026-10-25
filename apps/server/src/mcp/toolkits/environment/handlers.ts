import {
  globalIdleCompaction,
  type KeybindingsConfigError,
  OrchestratorMcpFailure,
  type ResolvedKeybindingsConfig,
  RuntimeMode,
  type ServerSettings,
  shouldRecommendDatabaseCompaction,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as CloudLink from "../../../cloud/CloudLink.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as DatabaseStorage from "../../../persistence/DatabaseStorage.ts";
import * as Settings from "../../../serverSettings.ts";
import * as StorageCleanup from "../../../storageCleanup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    completionAudio,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
    sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge,
    sidebarAutoSettleKeepPullRequests,
    favorites,
    providerModelPreferences,
    snoozeLimitedThreads,
    autoResumeLimitedThreads,
    continueThreadsAfterServerUpdate,
    responseStreamingMode,
    defaultRuntimeMode,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    completionAudio,
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
    sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge,
    sidebarAutoSettleKeepPullRequests,
    favorites,
    providerModelPreferences,
    idleCompaction: globalIdleCompaction(settings),
    snoozeLimitedThreads,
    autoResumeLimitedThreads,
    continueThreadsAfterServerUpdate,
    responseStreamingMode,
    defaultRuntimeMode,
  };
}
// Literals are declared narrowest first.
const runtimeModeRank = (mode: RuntimeMode) => RuntimeMode.literals.indexOf(mode);
// Explicit fields only: the link state also carries the linked account id and
// relay identifiers, which must not reach a provider transcript.
const connectSummary = Effect.gen(function* () {
  const cloud = yield* CloudLink.CloudLink;
  const state = yield* cloud.linkState();
  const reachability = state.reachability;
  return {
    linked: state.linked,
    linkRevoked: state.linkRevoked ?? false,
    managedTunnelActive: state.managedTunnelActive ?? false,
    publishAgentActivity: state.publishAgentActivity,
    holdWebhooksWhileOffline: state.holdWebhooksWhileOffline ?? false,
    reachability:
      reachability === undefined
        ? null
        : reachability.status === "reachable"
          ? { status: reachability.status, checkedAt: reachability.checkedAt }
          : {
              status: reachability.status,
              checkedAt: reachability.checkedAt,
              cause: reachability.cause,
            },
  };
}).pipe(
  // A secret-store read failure leaves Connect status unknown; the rest of the read stands.
  Effect.orElseSucceed(() => null),
);
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
/**
 * Runs an environment write under the calling thread's lock. `check` runs
 * again once the lock is held: the turn may have ended, or the thread's modes
 * changed, while this waited.
 */
const underCallerLock = Effect.fn("EnvironmentToolkit.underCallerLock")(function* <A, E, R, E2, R2>(
  check: Effect.Effect<unknown, E2, R2>,
  write: Effect.Effect<A, E, R>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const update = Effect.andThen(check, write);
  return yield* scope.thread === undefined
    ? update
    : executor.withLock(scope.thread.threadId, update);
});
// The error's own message embeds the config path; `detail` is a fixed description.
const keybindingsFailure = (error: KeybindingsConfigError) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `Keybindings config: ${error.detail}.`,
  });
const keybindingsWrite = Effect.fn("EnvironmentToolkit.keybindingsWrite")(function* (
  write: (
    service: Keybindings.Keybindings["Service"],
  ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>,
) {
  yield* access;
  const service = yield* Keybindings.Keybindings;
  const keybindings = yield* write(service).pipe(Effect.mapError(keybindingsFailure));
  return { keybindings, issues: [] };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        connect: yield* connectSummary,
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    underCallerLock(
      check,
      Effect.gen(function* () {
        const { settings } = yield* access;
        const requested = patch.defaultRuntimeMode;
        if (requested !== undefined) {
          const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
          yield* resolveRuntimeMode(current.defaultRuntimeMode, requested).pipe(
            Effect.mapError(
              (failure) =>
                new OrchestratorMcpFailure({
                  code: failure.code,
                  message:
                    "defaultRuntimeMode can only be lowered by agents; raise it in Settings.",
                }),
            ),
          );
        }
        // The rank check repeats under the settings write lock so a human
        // lowering the default between the check above and the write is kept.
        const updated = yield* settings
          .modifySettings((current) => {
            if (
              requested === undefined ||
              runtimeModeRank(requested) <= runtimeModeRank(current.defaultRuntimeMode)
            )
              return patch;
            const { defaultRuntimeMode: _raised, ...rest } = patch;
            return rest;
          })
          .pipe(Effect.mapError(unavailable));
        return preferences(updated);
      }),
    ),
  ),
  t3_keybindings_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* access;
      const service = yield* Keybindings.Keybindings;
      return yield* service.loadConfigState.pipe(Effect.mapError(keybindingsFailure));
    }),
  ),
  t3_keybinding_upsert: McpToolAccess.writesEnvironment((rule, check) =>
    underCallerLock(
      check,
      keybindingsWrite((service) => service.upsertKeybindingRule(rule)),
    ),
  ),
  t3_keybinding_remove: McpToolAccess.writesEnvironment((rule, check) =>
    underCallerLock(
      check,
      keybindingsWrite((service) => service.removeKeybindingRule(rule)),
    ),
  ),
  // Totals only: cleanup entries carry paths and thread titles, and the
  // compact command embeds the base directory.
  t3_environment_storage_report: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* access;
      const cleanup = yield* StorageCleanup.StorageCleanup;
      const database = yield* DatabaseStorage.DatabaseStorage;
      const status = Option.getOrNull(yield* Stream.runHead(database.status));
      const report = yield* cleanup.latestReport;
      return {
        database:
          status === null
            ? null
            : {
                databaseBytes: status.databaseBytes,
                reclaimableBytes: status.reclaimableBytes,
                incrementalVacuumEnabled: status.incrementalVacuumEnabled,
                compactionRecommended: shouldRecommendDatabaseCompaction(status),
              },
        lastCleanup:
          report === null
            ? null
            : {
                trigger: report.trigger,
                startedAt: report.startedAt,
                finishedAt: report.finishedAt,
                counts: report.counts,
                bytesFreed: report.bytesFreed,
                entryCount: report.entries.length + report.omittedCount,
              },
      };
    }),
  ),
});
