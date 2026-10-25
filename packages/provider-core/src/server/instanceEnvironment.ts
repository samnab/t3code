import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});

/**
 * Applies one thread's voice preference to a provider process environment. Only
 * correct for a provider with one process per thread; Codex shares an
 * app-server, so its preference travels through the per-native-thread files in
 * `voice/CodexVoicePreferenceFiles.ts`.
 */
export function withVoiceNotificationsEnv(
  env: NodeJS.ProcessEnv,
  enabled: boolean | undefined,
): NodeJS.ProcessEnv {
  return { ...env, T3_VOICE_NOTIFICATIONS: enabled === true ? "1" : "0" };
}
