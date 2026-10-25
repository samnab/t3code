import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2TurnItem,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { historicalMessage } from "@t3tools/provider-core/server/handoffBudget";
import * as DateTime from "effect/DateTime";

import { withHandoffVoice } from "./Orchestrator.ts";

const now = DateTime.makeUnsafe("2026-10-24T00:00:00.000Z");
const threadId = ThreadId.make("thread:handoff-voice");
const target = ProviderThreadId.make("provider-thread:target");
const source = ProviderThreadId.make("provider-thread:source");

const base = (id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  nodeId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});

const answer = (id: string, run: number, ordinal: number): OrchestrationV2TurnItem => ({
  ...base(id, ordinal),
  runId: RunId.make(`run:${run}`),
  providerThreadId: source,
  type: "assistant_message",
  messageId: MessageId.make(`message:${id}`),
  text: id,
  streaming: false,
});

const voice = (
  id: string,
  ordinal: number,
  providerThreadId = source,
  captureState: "canonical_completed" | "interrupted" = "canonical_completed",
): OrchestrationV2TurnItem => ({
  ...base(id, ordinal),
  runId: null,
  providerThreadId,
  type: "realtime_voice",
  providerInstanceId: ProviderInstanceId.make("codex"),
  nativeThreadId: "native-source",
  realtimeSessionId: "session",
  nativeRealtimeItemId: id,
  content: { type: "transcriptSegment", role: "user", text: `spoken ${id}` },
  captureState,
  historyCoverage: "live_only",
  sourceOrder: "unreconciled",
  timestampProvenance: "observed",
});

it("carries runless voice in its run buckets, in order, as labelled history", () => {
  const items = [answer("a2", 2, 2_000_001), answer("a3", 3, 3_000_001)];
  const selected = withHandoffVoice({
    items,
    voice: [
      voice("before-delta", 1_000_064),
      voice("between", 2_000_064),
      voice("after-delta", 4_000_064),
      voice("already-native", 2_000_128, target),
    ],
    fromRunOrdinal: 2,
    toRunOrdinal: 3,
    targetProviderThreadId: target,
  });
  assert.deepEqual(
    selected.map((item) => item.id),
    ["a2", "between", "a3"],
  );
  const speech = historicalMessage(selected[1]!);
  assert.equal(speech?.kind, "realtime_voice");
  assert.equal(speech?.role, "user");
});

it("takes all earlier speech for full history and leaves tails to historicalMessage", () => {
  const selected = withHandoffVoice({
    items: [answer("a1", 1, 1_000_001)],
    voice: [voice("opening", 64), voice("tail", 1_000_128, source, "interrupted")],
    fromRunOrdinal: 1,
    toRunOrdinal: null,
    targetProviderThreadId: target,
  });
  assert.deepEqual(
    selected.map((item) => item.id),
    ["opening", "a1", "tail"],
  );
  assert.isNull(historicalMessage(selected[2]!));
});
