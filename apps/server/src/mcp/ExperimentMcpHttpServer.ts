import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import { ExperimentHandlersLive, ExperimentToolkit } from "./toolkits/experiment.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_experiment_mcp_credential",
    message: "A valid experiment-scoped MCP bearer credential is required.",
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

type ExperimentMcpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const makeExperimentMcpAuthMiddleware = McpSessionRegistry.pipe(
  Effect.map((registry): ExperimentMcpAuthMiddleware =>
    Effect.fn("ExperimentMcpHttpServer.authenticateRequest")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (
        invocation === undefined ||
        invocation.experiment === undefined ||
        invocation.capabilities.size !== 1 ||
        !invocation.capabilities.has("experiment")
      ) {
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      );
    }),
  ),
  Effect.withSpan("ExperimentMcpHttpServer.makeAuthMiddleware"),
);

const ExperimentMcpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeExperimentMcpAuthMiddleware).layer;

export const ExperimentToolkitRegistrationLive = McpServer.toolkit(ExperimentToolkit).pipe(
  Layer.provide(ExperimentHandlersLive),
);

const ExperimentMcpTransportLive = McpServer.layerHttp({
  name: "T3 Code Experiment",
  version: packageJson.version,
  path: "/mcp/experiment",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(ExperimentMcpAuthMiddlewareLive));

/** Mount beside the general MCP layer after providing ExperimentMcpService. */
export const layer = Layer.fresh(
  ExperimentToolkitRegistrationLive.pipe(Layer.provideMerge(ExperimentMcpTransportLive)),
);
