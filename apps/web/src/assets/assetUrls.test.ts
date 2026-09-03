import { describe, expect, it } from "vite-plus/test";

import { isAssetUrlCurrent } from "./assetUrls";

describe("isAssetUrlCurrent", () => {
  it("rejects an expired cached capability when a chat remounts", () => {
    expect(isAssetUrlCurrent({ expiresAt: 1_000 }, 1_001)).toBe(false);
  });

  it("renews before the cached capability expires", () => {
    expect(isAssetUrlCurrent({ expiresAt: 31_001 }, 1_000)).toBe(true);
    expect(isAssetUrlCurrent({ expiresAt: 31_000 }, 1_000)).toBe(false);
  });
});
