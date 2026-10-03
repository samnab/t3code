import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface TurnOutputThroughput {
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly tokensPerSecond: number;
}

/** Derives whole-turn output throughput from durable V2 turn facts. */
export function deriveTurnOutputThroughput(
  turn: Pick<OrchestrationV2ProviderTurn, "startedAt" | "completedAt" | "turnTokenUsage">,
): TurnOutputThroughput | null {
  const outputTokens = turn.turnTokenUsage?.outputTokens;
  if (turn.startedAt === null || turn.completedAt === null || outputTokens === undefined) {
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
