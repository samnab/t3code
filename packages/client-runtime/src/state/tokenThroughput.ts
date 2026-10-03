import type {
  NodeId,
  OrchestrationV2ProviderTurn,
  ProviderThreadId,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface TurnOutputThroughput {
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly tokensPerSecond: number;
}

/** Derives whole-turn output throughput from durable V2 turn facts. */
export function deriveTurnOutputThroughput(
  turn: Pick<
    OrchestrationV2ProviderTurn,
    "status" | "startedAt" | "completedAt" | "turnTokenUsage"
  >,
): TurnOutputThroughput | null {
  const outputTokens = turn.turnTokenUsage?.outputTokens;
  if (
    turn.status !== "completed" ||
    turn.startedAt === null ||
    turn.completedAt === null ||
    outputTokens === undefined ||
    outputTokens === 0
  ) {
    return null;
  }

  const durationMs =
    DateTime.toEpochMillis(turn.completedAt) - DateTime.toEpochMillis(turn.startedAt);
  if (durationMs <= 0) return null;

  return {
    outputTokens,
    durationMs,
    tokensPerSecond: outputTokens / (durationMs / 1_000),
  };
}

/** Derives throughput from the newest provider turn for one completed run. */
export function deriveRunOutputThroughput(input: {
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly nodes: ReadonlyArray<{ readonly id: NodeId; readonly runId: RunId | null }>;
  readonly runId: RunId;
  readonly providerThreadId: ProviderThreadId | null;
}): TurnOutputThroughput | null {
  if (input.providerThreadId === null) return null;
  const turn = input.providerTurns.findLast(
    (candidate) =>
      candidate.providerThreadId === input.providerThreadId &&
      input.nodes.find((node) => node.id === candidate.nodeId)?.runId === input.runId,
  );
  return turn === undefined ? null : deriveTurnOutputThroughput(turn);
}
