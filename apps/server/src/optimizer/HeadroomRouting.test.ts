// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  claudeSettingsRouteThroughHeadroom,
  detectHeadroomRouting,
  inspectCodexHeadroomRouting,
  isHeadroomProxyUrl,
} from "./HeadroomRouting.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

describe("HeadroomRouting", () => {
  it("accepts only the fixed local proxy URL for each provider", () => {
    expect(isHeadroomProxyUrl("http://127.0.0.1:6767", "claudeAgent")).toBe(true);
    expect(isHeadroomProxyUrl("http://localhost:6767/v1/", "codex")).toBe(true);
    expect(isHeadroomProxyUrl("http://127.0.0.1:6767/v1", "claudeAgent")).toBe(false);
    expect(isHeadroomProxyUrl("https://127.0.0.1:6767/v1", "codex")).toBe(false);
    expect(isHeadroomProxyUrl("http://127.0.0.1:8787/v1", "codex")).toBe(false);
  });

  it("reads only Claude's settings env route", () => {
    expect(
      claudeSettingsRouteThroughHeadroom(
        '{"apiKey":"do-not-read","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:6767"}}',
      ),
    ).toBe(true);
    expect(claudeSettingsRouteThroughHeadroom('{"env":{"ANTHROPIC_BASE_URL":"custom"}}')).toBe(
      false,
    );
    expect(claudeSettingsRouteThroughHeadroom("not json")).toBe(false);
  });

  it("reads Codex routing fields only from the root and headroom provider table", () => {
    const inspected = inspectCodexHeadroomRouting(`
model_provider = "headroom"
openai_base_url = "http://127.0.0.1:6767/v1"

[model_providers.headroom]
name = "Headroom"
base_url = "http://127.0.0.1:6767/v1"

[profiles.other]
model_provider = "other"
`);

    expect(inspected).toEqual({
      modelProvider: "headroom",
      openAiBaseUrl: "http://127.0.0.1:6767/v1",
      headroomBaseUrl: "http://127.0.0.1:6767/v1",
    });
  });

  it.effect(
    "uses the selected Claude instance home and lets its environment override settings",
    () =>
      Effect.gen(function* () {
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-claude-"));
        try {
          NodeFS.writeFileSync(
            NodePath.join(home, "settings.json"),
            '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:6767"}}',
          );
          const settings = decodeSettings({
            providerInstances: {
              claude_work: {
                driver: "claudeAgent",
                environment: [
                  {
                    name: "ANTHROPIC_BASE_URL",
                    value: "https://gateway.example.test",
                    sensitive: false,
                  },
                ],
                config: { homePath: home },
              },
            },
          });

          expect(
            yield* detectHeadroomRouting({
              provider: claude,
              providerInstanceId: ProviderInstanceId.make("claude_work"),
              settings,
              environment: {},
            }),
          ).toBe(false);
        } finally {
          NodeFS.rmSync(home, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the selected Codex instance home and accepts the managed provider route", () =>
    Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "headroom-codex-"));
      try {
        NodeFS.writeFileSync(
          NodePath.join(home, "config.toml"),
          [
            "# --- Headroom init provider ---",
            'model_provider = "headroom"',
            'openai_base_url = "http://127.0.0.1:6767/v1"',
            "[model_providers.headroom]",
            'base_url = "http://127.0.0.1:6767/v1"',
            "# --- end Headroom init provider ---",
          ].join("\n"),
        );
        const settings = decodeSettings({
          providerInstances: {
            codex_work: {
              driver: "codex",
              config: { homePath: home },
            },
          },
        });

        expect(
          yield* detectHeadroomRouting({
            provider: codex,
            providerInstanceId: ProviderInstanceId.make("codex_work"),
            settings,
            environment: {},
          }),
        ).toBe(true);
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts an effective ambient Codex base URL without a managed config block", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({});
      expect(
        yield* detectHeadroomRouting({
          provider: codex,
          providerInstanceId: ProviderInstanceId.make("codex"),
          settings,
          environment: { OPENAI_BASE_URL: "http://127.0.0.1:6767/v1" },
        }),
      ).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
