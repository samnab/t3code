import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

export interface RtkRewriteCommandResult {
  readonly code: number;
  readonly stdout: string;
}

export type RtkRewriteRunner = (command: string) => Promise<RtkRewriteCommandResult>;

export function isSupportedRtkVersion(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version ?? "",
  );
  if (match === null) return false;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== 0) return major > 0;
  if (minor !== 23) return minor > 23;
  if (patch !== 0) return patch > 0;
  return match[4] === undefined;
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applyRtkRewriteResult(
  toolInput: Readonly<Record<string, unknown>>,
  result: RtkRewriteCommandResult,
): HookJSONOutput {
  const command = toolInput.command;
  if (typeof command !== "string" || (result.code !== 0 && result.code !== 3)) {
    return {};
  }

  const rewritten = result.stdout.trim();
  if (rewritten.length === 0 || rewritten === command) {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...toolInput, command: rewritten },
    },
  };
}

export async function runRtkPreToolUseHook(
  input: PreToolUseHookInput,
  rewrite: RtkRewriteRunner,
): Promise<HookJSONOutput> {
  if (input.tool_name !== "Bash") {
    return {};
  }
  if (!isUnknownRecord(input.tool_input)) {
    return {};
  }
  const command = Reflect.get(input.tool_input, "command");
  if (typeof command !== "string" || command.length === 0) {
    return {};
  }

  try {
    return applyRtkRewriteResult(input.tool_input, await rewrite(command));
  } catch {
    return {};
  }
}
