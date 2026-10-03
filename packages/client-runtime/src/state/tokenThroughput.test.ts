import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveTurnOutputThroughput } from "./tokenThroughput.ts";

const turn = (
  overrides: Pick<OrchestrationV2ProviderTurn, "startedAt" | "completedAt" | "turnTokenUsage">,
) => overrides;

describe("deriveTurnOutputThroughput", () => {
  it("derives whole-turn output tokens per second", () => {
    expect(
      deriveTurnOutputThroughput(
        turn({
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
      deriveTurnOutputThroughput(turn({ startedAt, completedAt: null, turnTokenUsage: undefined })),
    ).toBeNull();
    expect(
      deriveTurnOutputThroughput(
        turn({
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
});
