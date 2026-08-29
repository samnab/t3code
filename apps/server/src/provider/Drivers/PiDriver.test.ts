import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { PiSettings } from "@t3tools/contracts";

import { PiDriver } from "./PiDriver.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("PiDriver registration", () => {
  it("registers the pi driver among the built-in drivers", () => {
    const kinds = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);
    expect(kinds).toContain(PiDriver.driverKind);
    expect(PiDriver.driverKind).toBe(
      Schema.decodeSync(Schema.String.pipe(Schema.brand("ProviderDriverKind")))("pi"),
    );
  });

  it("decodes an empty config to disabled Early Access defaults", () => {
    const config = PiDriver.defaultConfig();
    expect(config.enabled).toBe(false);
    // An empty binary path decodes to the pi fallback.
    expect(config.binaryPath).toBe("pi");
    expect(config.launchArgs).toBe("");
    expect(PiDriver.configSchema).toBe(PiSettings);
    expect(PiDriver.metadata.displayName).toBe("Pi");
    expect(PiDriver.metadata.supportsMultipleInstances).toBe(true);
  });

  it("preserves a configured binary path and launch args through the schema", () => {
    const config = decodePiSettings({
      enabled: true,
      binaryPath: "/opt/pi/bin/pi",
      launchArgs: "--no-skills",
    });
    expect(config.enabled).toBe(true);
    expect(config.binaryPath).toBe("/opt/pi/bin/pi");
    expect(config.launchArgs).toBe("--no-skills");
  });
});
