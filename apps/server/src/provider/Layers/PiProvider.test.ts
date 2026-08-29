// @effect-diagnostics nodeBuiltinImport:off - the fake pi fixture drives a real stdio process through Node spawn and filesystem APIs.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PiSettings } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const FIXTURE_SCRIPT_PATH = NodePath.join(import.meta.dirname, "../testUtils/fake-pi.mjs");

const testLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makeFixture = (): string => {
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-provider-test-"));
  const scriptPath = NodePath.join(fixtureRoot, "fake-pi.mjs");
  NodeFS.writeFileSync(scriptPath, NodeFS.readFileSync(FIXTURE_SCRIPT_PATH, "utf8"));
  const shimPath = NodePath.join(fixtureRoot, "pi");
  NodeFS.writeFileSync(shimPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`);
  NodeFS.chmodSync(shimPath, 0o755);
  NodeFS.writeFileSync(NodePath.join(fixtureRoot, "received.ndjson"), "");
  process.env.FAKE_PI_LOG = NodePath.join(fixtureRoot, "received.ndjson");
  process.env.FAKE_PI_SESSION_FILE = `${fixtureRoot}/native-session.jsonl`;
  delete process.env.FAKE_PI_VETO;
  delete process.env.FAKE_PI_BUSY;
  delete process.env.FAKE_PI_VERSION;
  return shimPath;
};

const provideTestEnv = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(testLayer));

describe("checkPiProviderStatus", () => {
  it("reports a disabled provider without probing", () =>
    Effect.gen(function* () {
      const shimPath = makeFixture();
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: false, binaryPath: shimPath }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.models.map((model) => model.slug)).toContain("default");
    }).pipe(provideTestEnv));

  it("discovers models, commands, and skills through the ephemeral RPC process", () =>
    Effect.gen(function* () {
      const shimPath = makeFixture();
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: true, binaryPath: shimPath }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.2.3");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth).toEqual({ status: "authenticated", type: "pi" });

      // Native Pi model catalog is preserved verbatim as provider/model slugs.
      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("zai/glm-5");
      expect(slugs).toContain("zai/glm-5-flash");
      const glm = snapshot.models.find((model) => model.slug === "zai/glm-5");
      expect(glm?.name).toBe("GLM 5");
      // The reasoning model advertises the thinking ladder including the
      // mapped xhigh level; the flash model does not.
      const glmOptions =
        glm?.capabilities && "options" in glm.capabilities && glm.capabilities.optionDescriptors
          ? glm.capabilities.optionDescriptors.find(
              (descriptor) => descriptor.id === "thinking" && "options" in descriptor,
            )
          : undefined;
      const thinkingValues =
        glmOptions && "options" in glmOptions ? glmOptions.options.map((option) => option.id) : [];
      expect(thinkingValues).toContain("xhigh");
      const flash = snapshot.models.find((model) => model.slug === "zai/glm-5-flash");
      expect(flash?.capabilities?.optionDescriptors ?? []).toHaveLength(0);

      expect(snapshot.slashCommands.map((command) => command.name)).toContain("review");
      const research = snapshot.skills.find((skill) => skill.name === "research");
      expect(research?.scope).toBe("user");
    }).pipe(provideTestEnv));

  it("rejects a Pi binary older than the minimum supported version", () =>
    Effect.gen(function* () {
      const shimPath = makeFixture();
      process.env.FAKE_PI_VERSION = "0.7.0";
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: true, binaryPath: shimPath }),
      );
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.7.0");
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("unsupported");
    }).pipe(provideTestEnv));

  it("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ enabled: true, binaryPath: "/nonexistent/pi-binary" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed");
    }).pipe(provideTestEnv));
});
