import type { HookJSONOutput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

export interface RtkRewriteCommandResult {
  readonly code: number;
  readonly stdout: string;
}

export type RtkRewriteRunner = (command: string) => Promise<RtkRewriteCommandResult>;

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

  if (result.code === 0) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "RTK auto-rewrite",
        updatedInput: { ...toolInput, command: rewritten },
      },
    };
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
  if (typeof input.tool_input !== "object" || input.tool_input === null) {
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
