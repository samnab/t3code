import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { PiSettings } from "./settings.ts";
const decodePiSettings = Schema.decodeUnknownSync(PiSettings);

describe("PiSettings model concurrency", () => {
  it("defaults to unlimited and accepts legacy settings with per-model caps", () => {
    expect(decodePiSettings({}).modelConcurrency).toEqual({});
    expect(decodePiSettings({ modelConcurrency: { "zai/glm-5": 4 } }).modelConcurrency).toEqual({
      "zai/glm-5": 4,
    });
  });

  it.each([0, -1, 1.5, 9007199254740992])("rejects an invalid cap: %s", (cap) => {
    expect(() => decodePiSettings({ modelConcurrency: { "zai/glm-5": cap } })).toThrow();
  });
});
