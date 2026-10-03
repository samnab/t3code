import * as Effect from "effect/Effect";

import * as AgentMessagingService from "../../AgentMessagingService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentMessagingToolkit } from "./tools.ts";

export const AgentMessagingHandlersLive = AgentMessagingToolkit.toLayer({
  agent_send: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const messaging = yield* AgentMessagingService.AgentMessagingService;
      return yield* messaging.send(scope, input);
    }),
  agent_inbox: (input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const messaging = yield* AgentMessagingService.AgentMessagingService;
      return yield* messaging.inbox(scope, input);
    }),
});
