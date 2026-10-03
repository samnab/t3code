import * as Schema from "effect/Schema";

import { RuntimeTaskId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Input accepted by the durable `agent_send` tool. */
export const AgentSendInput = Schema.Struct({
  messageId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  targetAgentId: RuntimeTaskId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
});
export type AgentSendInput = typeof AgentSendInput.Type;

export const AgentSendResult = Schema.Struct({
  messageId: Schema.String,
  senderAgentId: RuntimeTaskId,
  targetAgentId: RuntimeTaskId,
  status: Schema.Literals(["queued", "notified"]),
  deliveryRunId: RuntimeTaskId,
});
export type AgentSendResult = typeof AgentSendResult.Type;

/** Input accepted by the durable `agent_inbox` tool. */
export const AgentInboxInput = Schema.Struct({
  acknowledgeMessageIds: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(100))).check(
      Schema.isMaxLength(50),
    ),
  ),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type AgentInboxInput = typeof AgentInboxInput.Type;

export const AgentInboxResult = Schema.Struct({
  agentId: RuntimeTaskId,
  peers: Schema.Array(
    Schema.Struct({
      agentId: RuntimeTaskId,
      title: Schema.String,
      providerInstanceId: ProviderInstanceId,
      model: Schema.String,
      status: Schema.Literals(["starting", "running", "completed", "failed", "cancelled"]),
    }),
  ),
  peersTruncated: Schema.Boolean,
  messages: Schema.Array(
    Schema.Struct({
      messageId: Schema.String,
      senderAgentId: RuntimeTaskId,
      senderTitle: Schema.String,
      message: Schema.String,
      createdAt: Schema.String,
    }),
  ),
  acknowledgedMessageIds: Schema.Array(Schema.String),
  hasMore: Schema.Boolean,
});
export type AgentInboxResult = typeof AgentInboxResult.Type;
