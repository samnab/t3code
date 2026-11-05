import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AgentInboxInput,
  AgentInboxResult,
  AgentSendInput,
  AgentSendResult,
} from "./agentMessaging.ts";

const decodeAgentSendInput = Schema.decodeSync(AgentSendInput);
const decodeAgentSendResult = Schema.decodeSync(AgentSendResult);
const decodeAgentInboxInput = Schema.decodeSync(AgentInboxInput);
const decodeAgentInboxResult = Schema.decodeSync(AgentInboxResult);
const decodeUnknownInboxInput = Schema.decodeUnknownSync(AgentInboxInput);

describe("agent messaging contracts", () => {
  it("decodes durable send and inbox tool input/output", () => {
    expect(
      decodeAgentSendInput({
        messageId: "message-1",
        targetAgentId: "agent-2",
        message: "Please inspect the importer.",
      }),
    ).toMatchObject({ targetAgentId: "agent-2" });
    expect(
      decodeAgentSendResult({
        messageId: "message-1",
        senderAgentId: "agent-1",
        targetAgentId: "agent-2",
        status: "notified",
        deliveryRunId: "run-1",
      }),
    ).toMatchObject({ status: "notified", deliveryRunId: "run-1" });
    expect(
      decodeAgentInboxInput({
        acknowledgeMessageIds: ["message-1"],
        limit: 25,
      }),
    ).toEqual({ acknowledgeMessageIds: ["message-1"], limit: 25 });
    expect(
      decodeAgentInboxResult({
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
    expect(() =>
      decodeUnknownInboxInput({
        acknowledgeMessageIds: Array.from({ length: 51 }, (_, i) => `m-${i}`),
      }),
    ).toThrow();
    expect(() => decodeUnknownInboxInput({ limit: 0 })).toThrow();
  });
});
