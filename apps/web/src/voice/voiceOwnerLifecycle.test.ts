import { describe, expect, it } from "vite-plus/test";
import { voiceProviderIneligibility } from "./voiceOwnerLifecycle";

const thread = { providerSessionId: "s1", status: "idle", driver: "codex" } as const;

describe("voiceProviderIneligibility", () => {
  it("allows an idle Codex thread whose shared session is bound to another thread", () => {
    expect(voiceProviderIneligibility(thread, undefined)).toBeNull();
  });

  it("refuses an errored session, a closed thread, a missing session id and non-Codex", () => {
    expect(voiceProviderIneligibility(thread, { status: "error", driver: "codex" })).not.toBeNull();
    expect(voiceProviderIneligibility({ ...thread, status: "closed" }, undefined)).not.toBeNull();
    expect(
      voiceProviderIneligibility({ ...thread, providerSessionId: null }, undefined),
    ).not.toBeNull();
    expect(
      voiceProviderIneligibility({ ...thread, driver: "claudeAgent" }, undefined),
    ).not.toBeNull();
  });
});
