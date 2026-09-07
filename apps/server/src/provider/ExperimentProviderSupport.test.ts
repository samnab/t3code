import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import {
  buildCodexExperimentAppServerArgs,
  CODEX_EXPERIMENT_DISABLED_FEATURES,
  preflightExperimentProvider,
} from "./ExperimentProviderSupport.ts";

describe("experiment provider preflight", () => {
  it("supports only isolated Claude and Pi paths without a runtime probe", () => {
    expect(
      preflightExperimentProvider({
        driverKind: ProviderDriverKind.make("claudeAgent"),
        platform: "darwin",
      }),
    ).toMatchObject({ supported: true });
    expect(
      preflightExperimentProvider({
        driverKind: ProviderDriverKind.make("pi"),
        platform: "darwin",
      }),
    ).toMatchObject({ supported: true });
    for (const driverKind of ["cursor", "grok", "opencode", "antigravity"]) {
      expect(
        preflightExperimentProvider({
          driverKind: ProviderDriverKind.make(driverKind),
          platform: "darwin",
        }),
      ).toMatchObject({ supported: false, code: "PROVIDER_EXPERIMENT_UNSUPPORTED" });
    }
  });

  it("supports Codex only where its native read-only sandbox is enforced", () => {
    expect(
      preflightExperimentProvider({
        driverKind: ProviderDriverKind.make("codex"),
        platform: "win32",
      }),
    ).toMatchObject({ supported: false });
    expect(
      preflightExperimentProvider({
        driverKind: ProviderDriverKind.make("codex"),
        platform: "darwin",
      }),
    ).toEqual({ supported: true });
    expect(
      preflightExperimentProvider({
        driverKind: ProviderDriverKind.make("codex"),
        platform: "linux",
      }),
    ).toEqual({ supported: true });
  });

  it("builds strict Codex argv with every escape feature disabled", () => {
    const args = buildCodexExperimentAppServerArgs();
    expect(args.slice(0, 4)).toEqual([
      "app-server",
      "--strict-config",
      "-c",
      "web_search=disabled",
    ]);
    expect(args.join(" ")).not.toContain("--enable");
    for (const feature of CODEX_EXPERIMENT_DISABLED_FEATURES) {
      expect(args).toContain(`features.${feature}=false`);
    }
  });
});
