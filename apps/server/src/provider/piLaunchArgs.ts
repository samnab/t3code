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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";
import {
  PI_T3_MCP_EXTENSION_FILENAME,
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
} from "./piT3McpExtensionSource.ts";

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

function normalizedPiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = normalizedPiPath(extensionPath);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--extension" && args[index] !== "-e") continue;
    if (normalizedPiPath(args[index + 1] ?? "") === wanted) return true;
    index += 1;
  }
  return false;
}

export const materializePiT3McpExtension = Effect.fn("materializePiT3McpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const destination = `${normalizedPiPath(cacheDir)}/${PI_T3_MCP_EXTENSION_FILENAME}`;
  const existing = yield* fs.readFileString(destination).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== PI_T3_MCP_EXTENSION_SOURCE) {
    yield* fs.writeFileString(destination, PI_T3_MCP_EXTENSION_SOURCE);
  }
  return destination;
});

export interface BuildPiRpcLaunchInput {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  /** Adds `--no-session`; independent of extension and tool loading. */
  readonly ephemeral?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  readonly mcpSession?: McpProviderSessionConfig;
  readonly extensionPath?: string;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
}

export const PI_EXPERIMENT_TOOL_NAMES = [
  "experiment_status",
  "experiment_list_files",
  "experiment_read_file",
  "experiment_apply",
  "experiment_evaluate",
] as const;

export interface BuildPiExperimentRpcLaunchInput {
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig;
  readonly extensionPath: string;
}

/** Builds a fresh Pi process without consulting user launch arguments or resources. */
export function buildPiExperimentRpcLaunch(input: BuildPiExperimentRpcLaunchInput): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const environment = { ...input.environment };
  delete environment[T3_MCP_URL_ENV];
  delete environment[T3_MCP_BEARER_ENV];
  delete environment[T3_PI_RUNTIME_MODE_ENV];
  return {
    args: [
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--extension",
      input.extensionPath,
      "--no-builtin-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--tools",
      PI_EXPERIMENT_TOOL_NAMES.join(","),
    ],
    env: {
      ...environment,
      [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
      [T3_MCP_BEARER_ENV]: input.mcpSession.authorizationHeader.replace(/^Bearer\s+/, ""),
    },
  };
}

export function buildPiRpcLaunch(input: BuildPiRpcLaunchInput): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
} {
  const hasT3Mcp =
    input.disableExtensions !== true &&
    input.extensionPath !== undefined &&
    input.mcpSession !== undefined;
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
  if (
    input.disableExtensions !== true &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  const environment = { ...input.environment };
  // These values belong to the current T3 session. Never let a Pi child reuse
  // credentials inherited from the server or a parent provider process.
  delete environment[T3_MCP_URL_ENV];
  delete environment[T3_MCP_BEARER_ENV];
  delete environment[T3_PI_RUNTIME_MODE_ENV];
  return {
    args,
    env: {
      ...environment,
      ...(input.runtimeMode === undefined ? {} : { [T3_PI_RUNTIME_MODE_ENV]: input.runtimeMode }),
      ...(hasT3Mcp && input.mcpSession !== undefined
        ? {
            [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
            [T3_MCP_BEARER_ENV]: input.mcpSession.authorizationHeader.replace(/^Bearer\s+/, ""),
          }
        : {}),
    },
  };
}
