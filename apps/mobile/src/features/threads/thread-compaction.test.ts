import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadCompactionControl } from "./thread-compaction";

function provider(input?: { supportsCompact?: boolean }): ServerProvider {
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
    slashCommands: input?.supportsCompact ? [{ name: "compact" }] : [],
    skills: [],
  };
}

const idle = {
  sessionStatus: "ready",
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  draftHasContent: false,
  compactInFlight: false,
} as const;

describe("resolveThreadCompactionControl", () => {
  it("shows the control only when the provider declares /compact", () => {
    expect(
      resolveThreadCompactionControl({
        ...idle,
        provider: provider({ supportsCompact: true }),
      }).available,
    ).toBe(true);
    expect(resolveThreadCompactionControl({ ...idle, provider: provider() }).available).toBe(false);
    expect(resolveThreadCompactionControl({ ...idle, provider: null }).available).toBe(false);
  });

  it("disables while a turn runs, a request waits, the draft is dirty, or a compact is in flight", () => {
    const base = { ...idle, provider: provider({ supportsCompact: true }) };
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

  it("is enabled otherwise", () => {
    const control = resolveThreadCompactionControl({
      ...idle,
      provider: provider({ supportsCompact: true }),
    });
    expect(control).toMatchObject({ available: true, disabled: false, disabledReason: null });
  });
});
