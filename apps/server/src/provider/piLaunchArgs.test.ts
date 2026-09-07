import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import {
  buildPiExperimentRpcLaunch,
  buildPiRpcLaunch,
  PI_EXPERIMENT_TOOL_NAMES,
  resolvePiLaunchArgs,
} from "./piLaunchArgs.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

describe("resolvePiLaunchArgs", () => {
  it("accepts empty arguments", () => {
    expect(resolvePiLaunchArgs("")).toEqual({ ok: true, args: [] });
  });

  it("rejects T3-controlled built-ins", () => {
    for (const arg of ["--mode rpc", "--resume x", "--session abc", "--no-session", "--version"]) {
      const resolved = resolvePiLaunchArgs(arg);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.message).toMatch(/controlled by T3 Code/);
      }
    }
  });

  it("rejects positional prompts and single-dash flags", () => {
    const positional = resolvePiLaunchArgs("hello world");
    expect(positional.ok).toBe(false);

    const dashFlag = resolvePiLaunchArgs("-x");
    expect(dashFlag.ok).toBe(false);
  });

  it("splits equals-form built-in arguments into two tokens", () => {
    const resolved = resolvePiLaunchArgs("--model=zai/glm-5 --no-skills");
    expect(resolved).toEqual({ ok: true, args: ["--model", "zai/glm-5", "--no-skills"] });
  });

  it("requires a value for value-taking arguments", () => {
    const resolved = resolvePiLaunchArgs("--model");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.message).toMatch(/requires a value/);
    }
  });

  it("leaves unknown equals-form extension flags untouched", () => {
    const resolved = resolvePiLaunchArgs("--ext-flag=1");
    expect(resolved).toEqual({ ok: true, args: ["--ext-flag=1"] });
  });
});

describe("buildPiRpcLaunch", () => {
  it("always requests rpc mode and keeps user arguments", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: ["--no-skills"],
      environment: {},
    });
    expect(launch.args).toEqual(["--mode", "rpc", "--no-skills"]);
  });

  it("marks ephemeral processes as session-less", () => {
    const launch = buildPiRpcLaunch({ launchArgs: [], environment: {}, ephemeral: true });
    expect(launch.args).toEqual(["--mode", "rpc", "--no-session"]);
  });

  it("appends background restrictions after user arguments", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: ["--tools", "bash"],
      environment: {},
      ephemeral: true,
      disableExtensions: true,
      disableTools: true,
    });
    // Restrictions follow user args so a configured --tools cannot re-enable
    // unattended background code.
    expect(launch.args).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--tools",
      "bash",
      "--no-extensions",
      "--no-tools",
    ]);
  });

  it("strips T3-owned session credentials from the child environment", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: {
        PATH: "/usr/bin",
        T3_MCP_URL: "http://loopback",
        T3_MCP_BEARER_TOKEN: "secret",
      },
    });
    expect(launch.env.PATH).toBe("/usr/bin");
    expect(launch.env.T3_MCP_URL).toBeUndefined();
    expect(launch.env.T3_MCP_BEARER_TOKEN).toBeUndefined();
  });

  it("injects the session-bound T3 MCP bridge into a parent Pi process", () => {
    const launch = buildPiRpcLaunch({
      launchArgs: [],
      environment: {},
      extensionPath: "/cache/pi-t3-mcp-extension.ts",
      runtimeMode: "full-access",
      mcpSession: {
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("pi"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer secret",
      },
    });
    expect(launch.args).toEqual(["--mode", "rpc", "--extension", "/cache/pi-t3-mcp-extension.ts"]);
    expect(launch.env.T3_MCP_URL).toBe("http://127.0.0.1/mcp");
    expect(launch.env.T3_MCP_BEARER_TOKEN).toBe("secret");
    expect(launch.env.T3_PI_RUNTIME_MODE).toBe("full-access");
  });
});

describe("buildPiExperimentRpcLaunch", () => {
  it("uses only the T3 bridge and experiment tools", () => {
    const launch = buildPiExperimentRpcLaunch({
      environment: {
        PATH: "/usr/bin",
        T3_MCP_URL: "http://hostile.example/mcp",
        T3_MCP_BEARER_TOKEN: "hostile-token",
      },
      extensionPath: "/cache/pi-t3-mcp-extension.ts",
      mcpSession: {
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
        providerSessionId: "restricted-session",
        providerInstanceId: ProviderInstanceId.make("pi"),
        endpoint: "http://127.0.0.1/mcp/experiment",
        authorizationHeader: "Bearer restricted-token",
        experiment: { runId: "run-1", generation: 2 },
      },
    });

    expect(launch.args).toEqual([
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--extension",
      "/cache/pi-t3-mcp-extension.ts",
      "--no-builtin-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--tools",
      PI_EXPERIMENT_TOOL_NAMES.join(","),
    ]);
    expect(launch.args).not.toContain("-e");
    expect(launch.args).not.toContain("bash");
    expect(launch.env.T3_MCP_URL).toBe("http://127.0.0.1/mcp/experiment");
    expect(launch.env.T3_MCP_BEARER_TOKEN).toBe("restricted-token");
  });
});

describe("Pi T3 MCP extension", () => {
  it("completes the MCP handshake and throws failed tool results", () => {
    expect(PI_T3_MCP_EXTENSION_SOURCE).toContain('client.notify("notifications/initialized"');
    expect(PI_T3_MCP_EXTENSION_SOURCE).toContain('"isError" in result');
    expect(PI_T3_MCP_EXTENSION_SOURCE).toContain("throw new Error(resultText(result)");
    expect(PI_T3_MCP_EXTENSION_SOURCE).not.toContain("? { isError: true }");
  });
});
