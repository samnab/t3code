import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

const CODEX_MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

/**
 * Translate T3's child-subagent setting into Codex's total-thread and
 * child-thread configuration keys. The structured setting is appended after
 * user launch arguments so it has deterministic precedence over conflicts.
 */
export const codexSubagentConcurrencyArgs = (
  maxConcurrentSubagents?: string,
): ReadonlyArray<string> => {
  const value = maxConcurrentSubagents?.trim() ?? "";
  if (value === "" || !POSITIVE_INTEGER_PATTERN.test(value)) return [];

  const count = BigInt(value);
  if (count > CODEX_MAX_SAFE_INTEGER) return [];

  return [
    "-c",
    `agents.max_concurrent_threads_per_session=${count}`,
    "-c",
    `features.multi_agent_v2.max_concurrent_threads_per_session=${count + 1n}`,
  ];
};

export const codexAppServerArgs = (launchArgs?: string, maxConcurrentSubagents?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
  ...codexSubagentConcurrencyArgs(maxConcurrentSubagents),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
  maxConcurrentSubagents?: string,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs);
  return [
    ...launchAppServerArgs,
    ...(appServerArgs ?? []),
    ...codexSubagentConcurrencyArgs(maxConcurrentSubagents),
  ];
};
