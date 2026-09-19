import type { OrchestrationMessageRole } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderHandoffTranscript } from "./providerHandoff.ts";

const message = (role: OrchestrationMessageRole, text: string) => ({ role, text });

describe("buildProviderHandoffTranscript", () => {
  it("returns null without user or assistant text", () => {
    expect(buildProviderHandoffTranscript([])).toBeNull();
    expect(
      buildProviderHandoffTranscript([message("system", "instructions"), message("user", "   ")]),
    ).toBeNull();
  });

  it("keeps user and assistant messages in conversation order", () => {
    const transcript = buildProviderHandoffTranscript([
      message("system", "system prompt"),
      message("user", "first"),
      message("reasoning", "thinking"),
      message("assistant", "the plan"),
      message("user", "thanks"),
    ]);
    expect(transcript).toBe(
      [
        "<provider_handoff>",
        "You are taking over a conversation that was previously handled by a different agent in this same workspace. The transcript below is context only. The user's new message follows the transcript.",
        "</provider_handoff>",
      ].join("\n") + "\n\n[user]\nfirst\n\n[assistant]\nthe plan\n\n[user]\nthanks",
    );
  });

  it("truncates keeping the most recent messages", () => {
    const big = "x".repeat(10_000);
    const transcript = buildProviderHandoffTranscript([
      message("user", `${big} oldest`),
      message("assistant", `${big} middle`),
      message("user", `${big} newest`),
    ]);
    expect(transcript).toContain("(earlier messages omitted)");
    expect(transcript).toContain(`${big} middle`);
    expect(transcript?.endsWith(`[user]\n${big} newest`)).toBe(true);
    expect(transcript).not.toContain("oldest");
    // The newest block is kept even when it alone exceeds the cap.
    const oversized = buildProviderHandoffTranscript([message("user", "y".repeat(25_000))]);
    expect(oversized).toContain("[user]");
    expect(oversized?.endsWith("y".repeat(25_000))).toBe(true);
  });
});
