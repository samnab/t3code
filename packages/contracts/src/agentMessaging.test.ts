import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AgentInboxInput,
  AgentInboxResult,
  AgentSendInput,
  AgentSendResult,
} from "./agentMessaging.ts";

describe("agent messaging contracts", () => {
  it("decodes durable send and inbox tool input/output", () => {
    expect(
      Schema.decodeSync(AgentSendInput)({
        messageId: "message-1",
        targetAgentId: "agent-2",
        message: "Please inspect the importer.",
      }),
    ).toMatchObject({ targetAgentId: "agent-2" });
    expect(
      Schema.decodeSync(AgentSendResult)({
        messageId: "message-1",
        senderAgentId: "agent-1",
        targetAgentId: "agent-2",
        status: "notified",
        deliveryRunId: "run-1",
      }),
    ).toMatchObject({ status: "notified", deliveryRunId: "run-1" });
    expect(
      Schema.decodeSync(AgentInboxInput)({
        acknowledgeMessageIds: ["message-1"],
        limit: 25,
      }),
    ).toEqual({ acknowledgeMessageIds: ["message-1"], limit: 25 });
    expect(
      Schema.decodeSync(AgentInboxResult)({
        agentId: "agent-1",
        peers: [
          {
            agentId: "agent-2",
            title: "Importer review",
            providerInstanceId: "codex",
            model: "gpt-5.6-sol",
            status: "running",
          },
        ],
        peersTruncated: false,
        messages: [
          {
            messageId: "message-1",
            senderAgentId: "agent-2",
            senderTitle: "Importer review",
            message: "The schema is clean.",
            createdAt: "2026-10-02T00:00:00.000Z",
          },
        ],
        acknowledgedMessageIds: ["message-0"],
        hasMore: false,
      }),
    ).toMatchObject({ agentId: "agent-1", hasMore: false });
  });

  it("rejects oversized inbox batches and invalid limits", () => {
    const decode = Schema.decodeUnknownSync(AgentInboxInput);
    expect(() =>
      decode({ acknowledgeMessageIds: Array.from({ length: 51 }, (_, i) => `m-${i}`) }),
    ).toThrow();
    expect(() => decode({ limit: 0 })).toThrow();
  });
});
