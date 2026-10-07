import * as Effect from "effect/Effect";

import * as AgentMessagingService from "../../AgentMessagingService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AgentMessagingToolkit } from "./tools.ts";

// Both tools act as the calling thread: sending delivers into a peer's run and
// reading the inbox acknowledges what it returns.
export const layer = McpToolAccess.toLayer(AgentMessagingToolkit, {
  agent_send: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const messaging = yield* AgentMessagingService.AgentMessagingService;
      return yield* messaging.send(scope, input);
    }),
  ),
  agent_inbox: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const messaging = yield* AgentMessagingService.AgentMessagingService;
      return yield* messaging.inbox(scope, input);
    }),
  ),
});
