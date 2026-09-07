import type { ProviderDriverKind } from "@t3tools/contracts";

export const PROVIDER_EXPERIMENT_UNSUPPORTED = "PROVIDER_EXPERIMENT_UNSUPPORTED" as const;
export const CODEX_EXPERIMENT_MCP_SERVER_NAME = "t3_experiment";
export const CODEX_EXPERIMENT_TOOL_NAMES = [
  "experiment_status",
  "experiment_list_files",
  "experiment_read_file",
  "experiment_apply",
  "experiment_evaluate",
] as const;

export type ExperimentProviderPreflight =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly code: typeof PROVIDER_EXPERIMENT_UNSUPPORTED;
      readonly reason: string;
    };

const unsupported = (reason: string): ExperimentProviderPreflight => ({
  supported: false,
  code: PROVIDER_EXPERIMENT_UNSUPPORTED,
  reason,
});

/** Fail-closed provider support check used before issuing an experiment credential. */
export function preflightExperimentProvider(input: {
  readonly driverKind: ProviderDriverKind;
  readonly platform: NodeJS.Platform;
}): ExperimentProviderPreflight {
  if (input.driverKind === "claudeAgent" || input.driverKind === "pi") {
    return { supported: true };
  }
  if (input.driverKind !== "codex") {
    return unsupported(`Provider '${input.driverKind}' has no enforced experiment boundary.`);
  }
  const platform = input.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return unsupported(`Codex experiments are not supported on '${platform}'.`);
  }
  return { supported: true };
}

export const CODEX_EXPERIMENT_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "multi_agent",
  "multi_agent_v2",
  "code_mode",
  "apps",
  "plugins",
  "hooks",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "in_app_local_automation",
  "image_generation",
  "skill_search",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "standalone_web_search",
  "request_permissions_tool",
] as const;

/**
 * Strict app-server argv for a clean CODEX_HOME. CodeModeOnly models require the isolated host
 * transport for nested MCP dispatch; the runtime separately verifies its exact tool inventory.
 */
export function buildCodexExperimentAppServerArgs(): ReadonlyArray<string> {
  return [
    "app-server",
    "--strict-config",
    "-c",
    "web_search=disabled",
    "-c",
    "features.code_mode_host=true",
    ...CODEX_EXPERIMENT_DISABLED_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`]),
  ];
}
