import { describe, expect, it } from "vite-plus/test";

import { dedupeProviderSlashCommands } from "./providerSlashCommands.ts";

describe("dedupeProviderSlashCommands", () => {
  it("removes provider commands shadowed by T3 commands after normalized name comparison", () => {
    const providerCommands = [
      { name: "/MODEL", description: "provider model" },
      { name: " compact ", description: "compact" },
      { name: "review", description: "review" },
    ];

    expect(dedupeProviderSlashCommands(providerCommands, ["model", "/plan"])).toEqual([
      providerCommands[1],
      providerCommands[2],
    ]);
  });
});
