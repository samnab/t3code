/** Source for the T3-owned Pi extension that exposes this session's MCP tools. */
export const PI_T3_MCP_EXTENSION_FILENAME = "pi-t3-mcp-extension.ts";
export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";
export const T3_PI_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";

/**
 * Pi has no native MCP client. Its public extension API is the provider
 * boundary: this small bridge discovers T3's tools and forwards calls to the
 * session-bound HTTP MCP endpoint. It does not run or emulate another agent.
 */
export const PI_T3_MCP_EXTENSION_SOURCE = `\
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PROTOCOL = "2025-06-18";
const endpoint = process.env[${JSON.stringify(T3_MCP_URL_ENV)}];
const token = process.env[${JSON.stringify(T3_MCP_BEARER_ENV)}];

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
};

function parseResponse(body: string, contentType: string): JsonRpcResponse {
  if (!contentType.includes("text/event-stream")) return JSON.parse(body) as JsonRpcResponse;
  for (const line of body.split("\\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.length > 0) return JSON.parse(payload) as JsonRpcResponse;
  }
  throw new Error("T3 MCP returned an empty event stream.");
}

function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null) return String(result ?? "");
  const record = result as {
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    readonly structuredContent?: unknown;
  };
  const content = record.content?.flatMap((part) =>
    part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  ) ?? [];
  if (record.structuredContent !== undefined) content.push(JSON.stringify(record.structuredContent));
  return content.length > 0 ? content.join("\\n") : JSON.stringify(result);
}

function makeClient(url: string, bearer: string) {
  let nextId = 1;
  let sessionId: string | undefined;
  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: bearer.startsWith("Bearer ") ? bearer : \`Bearer \${bearer}\`,
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL,
        ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      signal,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const body = await response.text();
    if (!response.ok) throw new Error(\`T3 MCP \${method} failed (\${response.status}).\`);
    if (body.length === 0) return undefined;
    const parsed = parseResponse(body, response.headers.get("content-type") ?? "");
    if (parsed.error !== undefined) throw new Error(parsed.error.message ?? "T3 MCP request failed.");
    return parsed.result;
  };
  return { request };
}

export default async function t3McpExtension(pi: ExtensionAPI) {
  if (endpoint === undefined || token === undefined) return;
  const client = makeClient(endpoint, token);
  await client.request("initialize", {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: "t3-pi-mcp", version: "1.0.0" },
  });
  const listed = await client.request("tools/list", {}) as { readonly tools?: McpTool[] } | undefined;
  for (const tool of listed?.tools ?? []) {
    const registeredName = \`mcp__t3-code__\${tool.name}\`;
    const description = tool.description ?? tool.name;
    const unsafe = (Type as { Unsafe?: (schema: unknown) => unknown }).Unsafe;
    pi.registerTool({
      name: registeredName,
      label: tool.name,
      description,
      promptSnippet: description.split("\\n")[0] ?? tool.name,
      promptGuidelines: [\`Use \${registeredName} for T3 orchestration when applicable.\`],
      parameters: unsafe === undefined ? Type.Object({}, { additionalProperties: true }) : unsafe(tool.inputSchema ?? {}),
      async execute(_toolCallId, params, signal) {
        const result = await client.request("tools/call", { name: tool.name, arguments: params ?? {} }, signal);
        return {
          content: [{ type: "text", text: resultText(result) }],
          details: { server: "t3-code", tool: tool.name },
          ...(typeof result === "object" && result !== null && "isError" in result && result.isError === true
            ? { isError: true }
            : {}),
        };
      },
    });
  }
}
`;
