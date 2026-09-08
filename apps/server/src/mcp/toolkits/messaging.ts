import { Effect } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

import {
  AgentInboxInput,
  AgentInboxResult,
  AgentSendInput,
  AgentSendResult,
  ChildRunError,
  ChildRunService,
} from "../ChildRunService.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";

const dependencies = [McpInvocationContext, ChildRunService];

export const AgentMessagingToolkit = Toolkit.make(
  Tool.make("agent_send", {
    description:
      "Send a durable message to one native T3 child agent in your team. Choose a unique messageId and reuse it unchanged when retrying. T3 persists the message before notifying or resuming the target. A notified result means the provider accepted a message notice; the target acknowledges processing through agent_inbox.",
    parameters: AgentSendInput,
    success: AgentSendResult,
    failure: ChildRunError,
    dependencies,
  }),
  Tool.make("agent_inbox", {
    description:
      "List teammate addresses and up to 50 pending durable messages. Messages remain pending until you pass their IDs in acknowledgeMessageIds after processing them.",
    parameters: AgentInboxInput,
    success: AgentInboxResult,
    failure: ChildRunError,
    dependencies,
  }),
);

export const AgentMessagingHandlersLive = AgentMessagingToolkit.toLayer({
  agent_send: (input) =>
    Effect.gen(function* () {
      return yield* (yield* ChildRunService).agentSend(yield* McpInvocationContext, input);
    }),
  agent_inbox: (input) =>
    Effect.gen(function* () {
      return yield* (yield* ChildRunService).agentInbox(yield* McpInvocationContext, input);
    }),
});
