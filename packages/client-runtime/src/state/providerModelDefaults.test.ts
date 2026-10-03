import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveConfiguredProviderDefault,
  resolveNewThreadModelSelection,
} from "./providerModelDefaults.ts";

const instanceId = ProviderInstanceId.make("codex-work");
const carried: ModelSelection = {
  instanceId,
  model: "carried-model",
  options: [{ id: "reasoning_effort", value: "low" }],
};
const settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  providerModelPreferences: {
    ...DEFAULT_UNIFIED_SETTINGS.providerModelPreferences,
    [instanceId]: {
      hiddenModels: [],
      modelOrder: [],
      defaultModel: "configured-model",
      defaultOptions: [{ id: "reasoning_effort", value: "high" }],
    },
  },
};

describe("provider model defaults", () => {
  it("keeps the carried provider while replacing its configured model and options", () => {
    expect(resolveConfiguredProviderDefault(settings, carried)).toEqual({
      instanceId,
      model: "configured-model",
      options: [{ id: "reasoning_effort", value: "high" }],
    });
  });

  it("keeps project default priority above configured and carried selections", () => {
    const projectDefaultSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claude"),
      model: "project-model",
    };
    expect(
      resolveNewThreadModelSelection({
        projectDefaultSelection,
        carriedSelection: carried,
        shouldCarrySelection: true,
        settings,
      }),
    ).toBe(projectDefaultSelection);
  });

  it("does not manufacture a selection when carry-over is disabled", () => {
    expect(
      resolveNewThreadModelSelection({
        projectDefaultSelection: null,
        carriedSelection: carried,
        shouldCarrySelection: false,
        settings,
      }),
    ).toBeNull();
  });
});
