/**
 * Pi RPC launch composition and user launch-argument guardrails.
 *
 * Source: extracted from upstream T3 PR #7211
 * (`apps/server/src/orchestration-v2/Adapters/piT3McpInjection.ts`, head
 * `a00565fbfc34a5fefd1222e1868f41e36cb02378`, MIT, author StiensWout),
 * reduced to the session launch path — the T3 MCP bridge extension and its
 * runtime-mode permission hook belong to a later phase — see
 * `docs/fork/upstream-pr-ledger.md`.
 *
 * T3 owns `--mode` and native session identity, so user launch arguments
 * that select a different execution mode or session are rejected before
 * spawn. The user's `pi` binary, home configuration, extensions, skills,
 * and project trust decisions all load exactly as they do in the `pi` TUI.
 *
 * @module provider/piLaunchArgs
 */
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const RESERVED_PI_LAUNCH_ARGUMENTS = new Set([
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
]);

const PI_ARGUMENTS_WITH_VALUES = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
]);

const PI_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--offline",
  "--verbose",
]);

export type PiLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedPiArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_PI_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizePiBuiltInEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return PI_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

/**
 * Pi launch arguments may configure resources, models, tools, trust, and
 * storage. T3 owns RPC mode and session identity, so arguments that select a
 * different execution mode or native session are rejected before spawn.
 */
export function resolvePiLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  // Pi parses equals-form tokens only as extension flags, even when their name
  // matches a built-in option. Split known built-ins while leaving arbitrary
  // extension flags in their native form.
  const args = normalizePiBuiltInEqualsArguments(tokenizeCliArgs(launchArgs));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedPiArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Pi launch argument '${reserved}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Pi launch arguments cannot include positional prompts.",
      };
    }
    if (PI_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Pi launch argument '${arg}' requires a value.` };
      }
      index += 1;
      continue;
    }
    if (PI_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      // Pi extensions may register arbitrary long flags. Treat one following
      // non-flag token as that extension flag's value.
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Pi launch argument '${arg}' is not supported by T3 Code.` };
    }
    return {
      ok: false,
      message: `Pi launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  return { ok: true, args };
}

/** Environment keys T3 owns for its own sessions; never inherited by a Pi child. */
const T3_SESSION_ENV_KEYS = ["T3_MCP_URL", "T3_MCP_BEARER", "T3_PI_RUNTIME_MODE"] as const;

export interface BuildPiRpcLaunchInput {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  /** Ephemeral one-shot process (discovery, background text generation). */
  readonly ephemeral?: boolean;
  /**
   * No user is present on ephemeral background processes to answer an
   * extension dialog, so extensions and tools are disabled there only.
   * Real sessions never pass this: the user's extensions and tools must
   * load exactly as they do in the `pi` TUI.
   */
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
}

export function buildPiRpcLaunch(input: BuildPiRpcLaunchInput): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const args = [
    "--mode",
    "rpc",
    ...(input.ephemeral === true ? ["--no-session"] : []),
    ...input.launchArgs,
    // Restrictions follow user launch args so a configured --tools or
    // --extension cannot silently re-enable unattended background code.
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
  ];
  const environment = { ...input.environment };
  // These values belong to the current T3 session. Never let a Pi child reuse
  // credentials inherited from the server or a parent provider process.
  for (const key of T3_SESSION_ENV_KEYS) {
    delete environment[key];
  }
  return { args, env: environment };
}
