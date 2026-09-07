import type {
  CanUseTool,
  Options as ClaudeQueryOptions,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";

export const CLAUDE_EXPERIMENT_TOOL_NAMES = [
  "experiment_status",
  "experiment_list_files",
  "experiment_read_file",
  "experiment_apply",
  "experiment_evaluate",
] as const;

const CLAUDE_EXPERIMENT_MCP_TOOL_NAMES = new Set(
  CLAUDE_EXPERIMENT_TOOL_NAMES.map((name) => `mcp__t3-experiment__${name}`),
);

export const claudeExperimentCanUseTool: CanUseTool = (toolName, toolInput) =>
  Promise.resolve(
    CLAUDE_EXPERIMENT_MCP_TOOL_NAMES.has(toolName)
      ? ({ behavior: "allow", updatedInput: toolInput } satisfies PermissionResult)
      : ({
          behavior: "deny",
          message: "Only the experiment MCP tools are available in this session.",
        } satisfies PermissionResult),
  );

/** Exact SDK options for a fresh Claude experiment process. */
export function buildClaudeExperimentQueryOptions(input: {
  readonly cwd: string | undefined;
  readonly model: string | undefined;
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sessionId: string;
  readonly systemPrompt: NonNullable<ClaudeQueryOptions["systemPrompt"]>;
  readonly mcpSession: McpProviderSessionConfig;
}): ClaudeQueryOptions {
  return {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.model ? { model: input.model } : {}),
    pathToClaudeCodeExecutable: input.executablePath,
    systemPrompt: input.systemPrompt,
    sessionId: input.sessionId,
    persistSession: false,
    includePartialMessages: true,
    settingSources: [],
    settings: { disableAllHooks: true },
    tools: [],
    allowedTools: [],
    skills: [],
    agents: {},
    plugins: [],
    strictMcpConfig: true,
    canUseTool: claudeExperimentCanUseTool,
    env: {
      ...input.environment,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    mcpServers: {
      "t3-experiment": {
        type: "http",
        url: input.mcpSession.endpoint,
        headers: { Authorization: input.mcpSession.authorizationHeader },
      },
    },
  };
}
