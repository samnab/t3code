import {
  type EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeTaskId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { ExperimentMcpError, type ExperimentMcpIdentity } from "./ExperimentMcpModel.ts";

export type McpCapability =
  | "preview"
  | "device"
  | "pull-requests"
  | "delegation"
  | "experiment"
  | "messaging";

export interface AgentMessagingMcpBinding {
  readonly agentId: RuntimeTaskId;
  readonly parentThreadId: ThreadId;
}

export interface ExperimentMcpBinding {
  readonly runId: string;
  readonly generation: number;
}

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly experiment?: ExperimentMcpBinding;
  readonly agentMessaging?: AgentMessagingMcpBinding;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  Effect.flatMap(McpInvocationContext, (invocation) =>
    invocation.capabilities.has(capability)
      ? Effect.succeed(invocation)
      : // The conditional type narrows what the literal argument decided at runtime.
        Effect.fail(missingCapability(invocation, capability) as McpCapabilityError<C>),
  ).pipe(Effect.withSpan("mcp.requireCapability"));

export const requireExperimentMcpInvocation = Effect.fn("mcp.requireExperimentInvocation")(
  function* () {
    const invocation = yield* McpInvocationContext;
    if (
      invocation.capabilities.size !== 1 ||
      !invocation.capabilities.has("experiment") ||
      invocation.experiment === undefined
    ) {
      return yield* new ExperimentMcpError({
        code: "PROVIDER_EXPERIMENT_UNAUTHORIZED",
        message: "MCP credential is not bound to an experiment run.",
      });
    }
    const identity: ExperimentMcpIdentity = {
      threadId: invocation.threadId,
      providerInstanceId: invocation.providerInstanceId,
      providerSessionId: invocation.providerSessionId,
      runId: invocation.experiment.runId,
      generation: invocation.experiment.generation,
    };
    return identity;
  },
);
