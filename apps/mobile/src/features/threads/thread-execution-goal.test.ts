import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveExecutionGoalControl } from "./thread-execution-goal";

function provider(input?: { executionGoal?: "native" }): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input?.executionGoal ? { executionGoal: input.executionGoal } : {}),
  };
}

describe("resolveExecutionGoalControl", () => {
  it("hides the entry without the capability (other providers, old servers)", () => {
    expect(
      resolveExecutionGoalControl({ provider: null, sessionPresent: true, connected: true }),
    ).toEqual({ visible: false, disabled: true, disabledReason: null });
    expect(
      resolveExecutionGoalControl({
        provider: provider(),
        sessionPresent: true,
        connected: true,
      }).visible,
    ).toBe(false);
  });

  it("shows the entry for a Codex provider that declares it", () => {
    expect(
      resolveExecutionGoalControl({
        provider: provider({ executionGoal: "native" }),
        sessionPresent: true,
        connected: true,
      }),
    ).toEqual({ visible: true, disabled: false, disabledReason: null });
  });

  it("blocks the open while offline or without a live session, naming the recovery", () => {
    expect(
      resolveExecutionGoalControl({
        provider: provider({ executionGoal: "native" }),
        sessionPresent: true,
        connected: false,
      }),
    ).toEqual({
      visible: true,
      disabled: true,
      disabledReason: "Reconnect before opening Codex's execution goal.",
    });
    expect(
      resolveExecutionGoalControl({
        provider: provider({ executionGoal: "native" }),
        sessionPresent: false,
        connected: true,
      }),
    ).toEqual({
      visible: true,
      disabled: true,
      disabledReason: "Send a message to start this Codex session first.",
    });
  });
});
