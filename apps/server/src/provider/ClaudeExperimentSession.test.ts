import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  buildClaudeExperimentQueryOptions,
  CLAUDE_EXPERIMENT_TOOL_NAMES,
} from "./ClaudeExperimentSession.ts";

describe("buildClaudeExperimentQueryOptions", () => {
  const callbackOptions = {
    signal: AbortSignal.timeout(100),
    toolUseID: "tool-use",
    requestId: "request",
  };
  const options = buildClaudeExperimentQueryOptions({
    cwd: "/workspace",
    model: "claude-sonnet",
    executablePath: "/bin/claude",
    environment: { PATH: "/usr/bin" },
    sessionId: "fresh-session",
    systemPrompt: { type: "preset", preset: "claude_code" },
    mcpSession: {
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      providerSessionId: "provider-session",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1/mcp/experiment",
      authorizationHeader: "Bearer token",
      capabilities: new Set(["experiment"] as const),
      experiment: { runId: "run-1", generation: 1 },
    },
  });

  it("loads no user resources and only the experiment MCP server", () => {
    expect(options).toMatchObject({
      sessionId: "fresh-session",
      persistSession: false,
      settingSources: [],
      settings: { disableAllHooks: true },
      tools: [],
      allowedTools: [],
      skills: [],
      agents: {},
      plugins: [],
      strictMcpConfig: true,
    });
    expect(options).not.toHaveProperty("resume");
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["t3-experiment"]);
  });

  it("fails closed for every tool outside the experiment allowlist", async () => {
    for (const toolName of ["Bash", "Read", "Task", "mcp__t3-code__subagent_spawn"]) {
      await expect(options.canUseTool!(toolName, {}, callbackOptions)).resolves.toMatchObject({
        behavior: "deny",
      });
    }
    for (const toolName of CLAUDE_EXPERIMENT_TOOL_NAMES) {
      await expect(
        options.canUseTool!(`mcp__t3-experiment__${toolName}`, {}, callbackOptions),
      ).resolves.toMatchObject({ behavior: "allow" });
    }
  });
});
