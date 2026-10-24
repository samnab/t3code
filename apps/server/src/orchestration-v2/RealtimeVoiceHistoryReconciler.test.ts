import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

import { planRealtimeVoiceRecovery } from "./RealtimeVoiceHistoryReconciler.ts";

const driver = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread:voice-stitch");
const now = DateTime.makeUnsafe("2026-10-24T00:00:00.000Z");
const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:voice-stitch"),
  driver,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: ProviderSessionId.make("session:voice-stitch"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 2,
  handoffIds: [],
  forkedFrom: null,
  pendingBackgroundTasks: [],
  createdAt: now,
  updatedAt: now,
};

const providerTurn = (run: number): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`provider-turn:${run}`),
  providerThreadId: providerThread.id,
  nodeId: NodeId.make(`node:${run}`),
  runAttemptId: null,
  nativeTurnRef: { driver, nativeId: `t${run}`, strength: "strong" },
  ordinal: run,
  status: "completed",
  startedAt: now,
  completedAt: now,
});

const base = (id: string, run: number, ordinal: number, providerTurnId: ProviderTurnId | null) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: RunId.make(`run:${run}`),
  nodeId: null,
  providerThreadId: providerThread.id,
  providerTurnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

// Each run: an opening user message without a provider turn, then the provider's answer.
const codingItems = [1, 2].flatMap((run): Array<OrchestrationV2TurnItem> => [
  {
    ...base(`user:${run}`, run, run * 1_000_000 + 1, null),
    type: "user_message",
    messageId: MessageId.make(`message:user:${run}`),
    createdBy: "user",
    creationSource: "web",
    inputIntent: "turn_start",
    text: "work",
    attachments: [],
  },
  {
    ...base(`answer:${run}`, run, run * 1_000_000 + 2, ProviderTurnId.make(`provider-turn:${run}`)),
    type: "assistant_message",
    messageId: MessageId.make(`message:answer:${run}`),
    text: "done",
    streaming: false,
  },
]);

const speech = (
  position: number,
  id: string,
): ProviderAdapter.ProviderAdapterV2RealtimeHistoryEntry => ({
  type: "realtime",
  position,
  item: { id, realtimeSessionId: "session", type: "transcriptSegment", role: "user", text: id },
});

// The spoken request precedes its promotion record, which precedes the coding turn it started.
const history: ReadonlyArray<ProviderAdapter.ProviderAdapterV2RealtimeHistoryEntry> = [
  speech(1, "opening"),
  { type: "turnStarted", position: 2, nativeTurnId: "t1" },
  { type: "turnCompleted", position: 3, nativeTurnId: "t1", status: "completed" },
  speech(4, "request"),
  {
    type: "realtime",
    position: 5,
    item: {
      id: "promotion",
      realtimeSessionId: "session",
      type: "bemItemPromoted",
      item_id: "user-item",
      turn_id: "t2",
      presentation: { type: "wholeItem" },
    },
  },
  { type: "turnStarted", position: 6, nativeTurnId: "t2" },
  {
    type: "item",
    position: 7,
    nativeTurnId: "t2",
    nativeItemId: "answer",
    itemType: "agentMessage",
  },
  speech(8, "closing"),
];

it("stitches recovered speech between coding turns", () => {
  const items = planRealtimeVoiceRecovery({
    providerThread,
    threadId,
    nativeThreadId: "native-thread",
    entries: history,
    turnItems: codingItems,
    providerTurns: [providerTurn(1), providerTurn(2)],
    deriveId: IdAllocator.derive.realtimeVoiceTurnItem,
    now,
  });
  const ordinal = (id: string) => items.find((item) => item.nativeRealtimeItemId === id)!.ordinal;
  assert.deepEqual(
    items.map((item) => item.nativeRealtimeItemId),
    ["opening", "request", "promotion", "closing"],
  );
  assert.isTrue(items.every((item) => item.sourceOrder === "provider_anchored"));
  assert.isTrue(items.every((item) => item.runId === null && item.providerTurnId === null));
  // Opening speech precedes run 1, including its opening user message.
  assert.isTrue(ordinal("opening") < 1_000_001);
  // The spoken request and its promotion record sit after run 1 and before run 2 starts.
  assert.isTrue(1_000_002 < ordinal("request"));
  assert.isTrue(ordinal("request") < ordinal("promotion"));
  assert.isTrue(ordinal("promotion") < 2_000_001);
  assert.isTrue(ordinal("closing") > 2_000_002);
});
