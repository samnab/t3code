import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  IdleCompactionMode,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerRemoveKeybindingInput,
  ServerSettingsPatch,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  StorageCleanupReport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Keybindings from "../../../keybindings.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as DatabaseStorage from "../../../persistence/DatabaseStorage.ts";
import * as Settings from "../../../serverSettings.ts";
import * as StorageCleanup from "../../../storageCleanup.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PreferenceFields = {
  completionAudio: ServerSettings.fields.completionAudio,
  defaultThreadEnvMode: ServerSettings.fields.defaultThreadEnvMode,
  newWorktreesStartFromOrigin: ServerSettings.fields.newWorktreesStartFromOrigin,
  enableProviderUpdateChecks: ServerSettings.fields.enableProviderUpdateChecks,
  backgroundActivity: Schema.Struct({ profile: BackgroundActivityProfileSelection }),
  sourceControlWritingStyle: Schema.Struct({
    mode: Schema.String,
    followChangeRequestTemplates: Schema.Boolean,
    customInstructions: Schema.String,
    truncated: Schema.Boolean,
  }),
  sidebarAutoSettleAfterDays: ServerSettings.fields.sidebarAutoSettleAfterDays,
  sidebarAutoSettleOnMerge: ServerSettings.fields.sidebarAutoSettleOnMerge,
  sidebarAutoSettleKeepPullRequests: ServerSettings.fields.sidebarAutoSettleKeepPullRequests,
  favorites: ServerSettings.fields.favorites,
  providerModelPreferences: ServerSettings.fields.providerModelPreferences,
  idleCompaction: IdleCompactionMode,
  snoozeLimitedThreads: ServerSettings.fields.snoozeLimitedThreads,
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    Settings.ServerSettingsService,
    ThreadCommandExecutor.ThreadCommandExecutor,
  ],
};
const EnvironmentReadTool = Tool.make("t3_environment_read", {
  ...shared,
  description:
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`. Completion audio defaults apply to future top-level threads; Sound needs a web/desktop client. favorites and providerModelPreferences (hidden models, order, default model/options per provider instance id) are the stored model preferences. idleCompaction is the effective environment-wide mode.",
  success: Schema.Struct({
    environmentId: ExecutionEnvironmentDescriptor.fields.environmentId,
    label: Schema.String,
    serverVersion: Schema.String,
    platform: ExecutionEnvironmentDescriptor.fields.platform,
    preferences: Schema.Struct(PreferenceFields),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const EnvironmentPreferencesTool = Tool.make("t3_environment_preferences_update", {
  ...shared,
  description:
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it. `completionAudio` changes future defaults only; use `t3_completion_audio_bulk_off` for existing threads. Model preference ops are incremental: setModelFavorites and setModelsHidden set each listed entry's favorite/hidden flag, setProviderModelOrder replaces one provider's order, setProviderModelDefault merges that provider's defaults (defaultModel null clears). Provider instance ids come from orchestrator_capabilities and are not validated. idleCompaction sets the environment-wide mode; snoozeLimitedThreads snoozes usage-limited threads until their limit resets and does not resume them.",
  parameters: Schema.Struct({
    completionAudio: ServerSettingsPatch.fields.completionAudio,
    defaultThreadEnvMode: ServerSettingsPatch.fields.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: ServerSettingsPatch.fields.newWorktreesStartFromOrigin,
    enableProviderUpdateChecks: ServerSettingsPatch.fields.enableProviderUpdateChecks,
    backgroundActivity: Schema.optionalKey(Schema.Struct({ profile: BackgroundActivityProfile })),
    sourceControlWritingStyle: ServerSettingsPatch.fields.sourceControlWritingStyle,
    sidebarAutoSettleAfterDays: ServerSettingsPatch.fields.sidebarAutoSettleAfterDays,
    sidebarAutoSettleOnMerge: ServerSettingsPatch.fields.sidebarAutoSettleOnMerge,
    sidebarAutoSettleKeepPullRequests: ServerSettingsPatch.fields.sidebarAutoSettleKeepPullRequests,
    setModelFavorites: ServerSettingsPatch.fields.setModelFavorites,
    setModelsHidden: ServerSettingsPatch.fields.setModelsHidden,
    setProviderModelOrder: ServerSettingsPatch.fields.setProviderModelOrder,
    setProviderModelDefault: ServerSettingsPatch.fields.setProviderModelDefault,
    idleCompaction: ServerSettingsPatch.fields.idleCompaction,
    snoozeLimitedThreads: ServerSettingsPatch.fields.snoozeLimitedThreads,
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
const keybindings = {
  ...shared,
  dependencies: [...shared.dependencies, Keybindings.Keybindings],
  success: ServerUpsertKeybindingResult,
};
const KeybindingsListTool = Tool.make("t3_keybindings_list", {
  ...keybindings,
  description:
    "List this environment's effective keybindings (defaults merged with the user's custom rules) and any config issues. Shortcuts are returned parsed; t3_keybinding_remove matches the exact key/command/when strings a custom rule was written with.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const KeybindingUpsertTool = Tool.make("t3_keybinding_upsert", {
  ...keybindings,
  description:
    "Add or replace a custom keybinding rule through the normal keybindings config, notifying open clients. Requires a live full-access/default calling thread. key is a shortcut like mod+shift+k; command must be a known keybinding command or script.<id>.run; replace names an existing rule to swap out. Returns the effective keybindings.",
  parameters: ServerUpsertKeybindingInput,
}).annotate(Tool.Destructive, true);
const KeybindingRemoveTool = Tool.make("t3_keybinding_remove", {
  ...keybindings,
  description:
    "Remove the custom keybinding rule with exactly this key, command, and when. Requires a live full-access/default calling thread. Default keybindings cannot be removed. Returns the effective keybindings.",
  parameters: ServerRemoveKeybindingInput,
}).annotate(Tool.Destructive, true);
const StorageReportTool = Tool.make("t3_environment_storage_report", {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    StorageCleanup.StorageCleanup,
    DatabaseStorage.DatabaseStorage,
  ],
  description:
    "Summarize this environment's storage: state database size and reclaimable space, and the totals of the latest storage cleanup run. Either is null when not yet measured or not available. Read-only; cleanup and compaction stay with the user.",
  success: Schema.Struct({
    database: Schema.NullOr(
      Schema.Struct({
        databaseBytes: Schema.Number,
        reclaimableBytes: Schema.Number,
        incrementalVacuumEnabled: Schema.Boolean,
        compactionRecommended: Schema.Boolean,
      }),
    ),
    lastCleanup: Schema.NullOr(
      Schema.Struct({
        trigger: StorageCleanupReport.fields.trigger,
        startedAt: Schema.String,
        finishedAt: Schema.String,
        counts: StorageCleanupReport.fields.counts,
        bytesFreed: Schema.Number,
        entryCount: Schema.Number,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
export const EnvironmentToolkit = Toolkit.make(
  EnvironmentReadTool,
  EnvironmentPreferencesTool,
  KeybindingsListTool,
  KeybindingUpsertTool,
  KeybindingRemoveTool,
  StorageReportTool,
);
