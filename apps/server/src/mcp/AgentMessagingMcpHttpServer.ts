import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import { AgentMessagingHandlersLive, AgentMessagingToolkit } from "./toolkits/messaging.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_agent_messaging_credential",
    message: "A valid native-child messaging credential is required.",
  },
  {
    status: 401,
    headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type AgentMcpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const makeAgentMcpAuthMiddleware = McpSessionRegistry.pipe(
  Effect.map((registry): AgentMcpAuthMiddleware =>
    Effect.fn("AgentMessagingMcpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (
        invocation === undefined ||
        invocation.agentMessaging === undefined ||
        invocation.capabilities.size !== 1 ||
        !invocation.capabilities.has("messaging")
      ) {
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      );
    }),
  ),
  Effect.withSpan("AgentMessagingMcpHttpServer.makeAuthMiddleware"),
);

const AgentMcpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeAgentMcpAuthMiddleware).layer;

export const AgentMessagingToolkitRegistrationLive = McpServer.toolkit(AgentMessagingToolkit).pipe(
  Layer.provide(AgentMessagingHandlersLive),
);

const AgentMcpTransportLive = McpServer.layerHttp({
  name: "T3 Code Agent Messaging",
  version: packageJson.version,
  path: "/mcp/agent",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(AgentMcpAuthMiddlewareLive));

export const layer = Layer.fresh(
  AgentMessagingToolkitRegistrationLive.pipe(Layer.provideMerge(AgentMcpTransportLive)),
);
