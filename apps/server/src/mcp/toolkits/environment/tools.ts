import {
  BackgroundActivityProfile,
  BackgroundActivityProfileSelection,
  ExecutionEnvironmentDescriptor,
  OrchestratorMcpFailure,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
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
    "Read this server's identity and preferences. Providers and models: `orchestrator_capabilities`. Completion audio defaults apply to future top-level threads; Sound needs a web/desktop client. favorites and providerModelPreferences (hidden models, order, default model/options per provider instance id) are the stored model preferences.",
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
    "Update environment-wide preferences. Live full-access or default caller thread only. Omitted fields are unchanged; `customInstructions: ''` clears it. `completionAudio` changes future defaults only; use `t3_completion_audio_bulk_off` for existing threads. Model preference ops are incremental: setModelFavorites and setModelsHidden set each listed entry's favorite/hidden flag, setProviderModelOrder replaces one provider's order, setProviderModelDefault merges that provider's defaults (defaultModel null clears). Provider instance ids come from orchestrator_capabilities and are not validated.",
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
  }),
  success: Schema.Struct(PreferenceFields),
}).annotate(Tool.Destructive, true);
export const EnvironmentToolkit = Toolkit.make(EnvironmentReadTool, EnvironmentPreferencesTool);
