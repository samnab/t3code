import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadCompactionControl } from "./thread-compaction";

function provider(input?: { contextCompaction?: "prompt" | "native" }): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input?.contextCompaction ? { contextCompaction: input.contextCompaction } : {}),
  };
}

const idle = {
  sessionStatus: "ready",
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  draftHasContent: false,
  compactInFlight: false,
  connected: true,
} as const;

describe("resolveThreadCompactionControl", () => {
  it("exposes each mode and hides the control for unsupported providers and old servers", () => {
    expect(
      resolveThreadCompactionControl({
        ...idle,
        provider: provider({ contextCompaction: "prompt" }),
      }).mode,
    ).toBe("prompt");
    expect(
      resolveThreadCompactionControl({
        ...idle,
        provider: provider({ contextCompaction: "native" }),
      }).mode,
    ).toBe("native");
    expect(resolveThreadCompactionControl({ ...idle, provider: provider() }).mode).toBeNull();
    expect(resolveThreadCompactionControl({ ...idle, provider: null }).mode).toBeNull();
  });

  it("disables while a turn runs, a request waits, the draft is dirty, or a compact is in flight", () => {
    const base = { ...idle, provider: provider({ contextCompaction: "native" }) };
    expect(resolveThreadCompactionControl({ ...base, sessionStatus: "running" })).toMatchObject({
      disabled: true,
      disabledReason: "Stop the running turn before compacting.",
    });
    expect(resolveThreadCompactionControl({ ...base, sessionStatus: "starting" }).disabled).toBe(
      true,
    );
    expect(resolveThreadCompactionControl({ ...base, pendingApprovalCount: 1 }).disabled).toBe(
      true,
    );
    expect(resolveThreadCompactionControl({ ...base, pendingUserInputCount: 1 }).disabled).toBe(
      true,
    );
    expect(resolveThreadCompactionControl({ ...base, draftHasContent: true })).toMatchObject({
      disabled: true,
      disabledReason: "Send or clear your message before compacting.",
    });
    expect(resolveThreadCompactionControl({ ...base, compactInFlight: true })).toMatchObject({
      disabled: true,
      disabledReason: "Compacting…",
    });
  });

  it("requires a live connection only for native dispatch — prompt mode queues like any message", () => {
    const native = resolveThreadCompactionControl({
      ...idle,
      connected: false,
      provider: provider({ contextCompaction: "native" }),
    });
    expect(native).toMatchObject({
      disabled: true,
      disabledReason: "Reconnect before compacting.",
    });

    const prompt = resolveThreadCompactionControl({
      ...idle,
      connected: false,
      provider: provider({ contextCompaction: "prompt" }),
    });
    expect(prompt.disabled).toBe(false);
  });
});
