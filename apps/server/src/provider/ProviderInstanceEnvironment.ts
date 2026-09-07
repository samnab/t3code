import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}

/**
 * Thread voice-notification preference for a provider process: 1 when on
 * (the default), 0 when the user turned them off for that thread. The
 * provider's own hooks read T3_VOICE_NOTIFICATIONS; T3 never speaks anything.
 */
export function withVoiceNotificationsEnv(
  env: NodeJS.ProcessEnv,
  enabled: boolean | undefined,
): NodeJS.ProcessEnv {
  return { ...env, T3_VOICE_NOTIFICATIONS: enabled === false ? "0" : "1" };
}
