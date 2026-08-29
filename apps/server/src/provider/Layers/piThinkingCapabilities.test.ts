import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./piThinkingCapabilities.ts";

describe("thinkingCapabilitiesForPiModel", () => {
  it("adverts off..high for reasoning models and extra levels only when mapped", () => {
    const capabilities = thinkingCapabilitiesForPiModel(
      { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      "medium",
    );
    const descriptor = capabilities.optionDescriptors?.[0];
    expect(descriptor?.id).toBe("thinking");
    expect(
      descriptor && "options" in descriptor ? descriptor.options.map((o) => o.id) : [],
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    const defaultOption =
      descriptor && "options" in descriptor
        ? descriptor.options.find((option) => "isDefault" in option && option.isDefault)
        : undefined;
    expect(defaultOption?.id).toBe("medium");
  });

  it("returns empty capabilities for non-reasoning models", () => {
    expect(thinkingCapabilitiesForPiModel({ reasoning: false }, "high")).toEqual(
      EMPTY_PI_MODEL_CAPABILITIES,
    );
  });

  it("clamps an unknown default to the closest available level", () => {
    const capabilities = thinkingCapabilitiesForPiModel(
      { reasoning: true, thinkingLevelMap: null },
      "xhigh",
    );
    const descriptor = capabilities.optionDescriptors?.[0];
    const defaultOption =
      descriptor && "options" in descriptor
        ? descriptor.options.find((option) => "isDefault" in option && option.isDefault)
        : undefined;
    // xhigh is not in this model's map; the closest advertised level is high.
    expect(defaultOption?.id).toBe("high");
  });
});
