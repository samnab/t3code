import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveRunOutputThroughput, deriveTurnOutputThroughput } from "./tokenThroughput.ts";

const turn = (
  overrides: Pick<
    OrchestrationV2ProviderTurn,
    "status" | "startedAt" | "completedAt" | "turnTokenUsage"
  >,
) => overrides;

describe("deriveTurnOutputThroughput", () => {
  it("derives whole-turn output tokens per second", () => {
    expect(
      deriveTurnOutputThroughput(
        turn({
          status: "completed",
          startedAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-10-02T12:00:04.000Z"),
          turnTokenUsage: {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents: false,
            inputTokens: 0,
            outputTokens: 100,
          },
        }),
      ),
    ).toEqual({ outputTokens: 100, durationMs: 4_000, tokensPerSecond: 25 });
  });

  it("uses known output from partial usage", () => {
    expect(
      deriveTurnOutputThroughput(
        turn({
          status: "completed",
          startedAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-10-02T12:00:02.000Z"),
          turnTokenUsage: {
            usageStatus: "partial",
            usageScope: "main_agent",
            hasSubagents: false,
            outputTokens: 12,
          },
        }),
      )?.tokensPerSecond,
    ).toBe(6);
  });

  it("returns null when output or a positive completed duration is unavailable", () => {
    const startedAt = DateTime.makeUnsafe("2026-10-02T12:00:00.000Z");
    expect(
      deriveTurnOutputThroughput(
        turn({ status: "running", startedAt, completedAt: null, turnTokenUsage: undefined }),
      ),
    ).toBeNull();
    expect(
      deriveTurnOutputThroughput(
        turn({
          status: "failed",
          startedAt,
          completedAt: DateTime.makeUnsafe("2026-10-02T12:00:01.000Z"),
          turnTokenUsage: {
            usageStatus: "partial",
            usageScope: "main_agent",
            hasSubagents: false,
            outputTokens: 0,
          },
        }),
      ),
    ).toBeNull();
    expect(
      deriveTurnOutputThroughput(
        turn({
          status: "completed",
          startedAt,
          completedAt: startedAt,
          turnTokenUsage: {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents: false,
            inputTokens: 0,
            outputTokens: 1,
          },
        }),
      ),
    ).toBeNull();
  });

  it("does not reuse an earlier provider turn when the newest turn failed", () => {
    const runId = RunId.make("run-1");
    const nodeId = NodeId.make("node-1");
    const providerThreadId = ProviderThreadId.make("provider-thread-1");
    const providerTurn = (
      id: string,
      status: OrchestrationV2ProviderTurn["status"],
      outputTokens: number,
    ): OrchestrationV2ProviderTurn => ({
      id: ProviderTurnId.make(id),
      providerThreadId,
      nodeId,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: id === "provider-turn-1" ? 1 : 2,
      status,
      startedAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
      completedAt: DateTime.makeUnsafe("2026-10-02T12:00:10.000Z"),
      turnTokenUsage:
        status === "completed"
          ? {
              usageStatus: "complete",
              usageScope: "main_agent",
              hasSubagents: false,
              inputTokens: 0,
              outputTokens,
            }
          : {
              usageStatus: "partial",
              usageScope: "main_agent",
              hasSubagents: false,
              outputTokens,
            },
    });

    expect(
      deriveRunOutputThroughput({
        providerTurns: [
          providerTurn("provider-turn-1", "completed", 29),
          providerTurn("provider-turn-2", "failed", 0),
        ],
        nodes: [{ id: nodeId, runId }],
        runId,
        providerThreadId,
      }),
    ).toBeNull();
  });
});
