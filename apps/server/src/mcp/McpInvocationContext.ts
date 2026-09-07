import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { ExperimentMcpError, type ExperimentMcpIdentity } from "./ExperimentMcpModel.ts";

export type McpCapability = "preview" | "delegation" | "experiment";

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
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

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
