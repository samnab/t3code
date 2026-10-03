import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DelegationPolicy from "./DelegationPolicy.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

const provider = (input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly model: string;
  readonly enabled?: boolean;
}): ServerProvider => ({
  instanceId: input.instanceId,
  driver: ProviderDriverKind.make(input.driver),
  enabled: input.enabled ?? true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-02T00:00:00.000Z",
  models: [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

const makeLayer = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly adapterIds: ReadonlyArray<ProviderInstanceId>;
}) =>
  DelegationPolicy.layer.pipe(
    Layer.provide(DelegationPolicy.DelegationCandidateHeadroom.allowAll),
    Layer.provide(
      ServerSettings.layerTest({
        delegationTiers: {
          small: [
            { providerInstanceId: codex, model: "gpt-5.4" },
            { providerInstanceId: claude, model: "claude-sonnet-4-6" },
          ],
          medium: [],
          large: [],
        },
      }),
    ),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(input.providers),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed(input.adapterIds),
          get: () => Effect.die("adapter lookup is unused by the policy"),
        }),
      ),
    ),
  );

describe("DelegationPolicy", () => {
  it.effect("resolves the first available configured candidate", () =>
    Effect.gen(function* () {
      const policy = yield* DelegationPolicy.DelegationPolicy;
      assert.deepEqual(yield* policy.resolve("small"), {
        instanceId: codex,
        model: "gpt-5.4",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          providers: [
            provider({ instanceId: codex, driver: "codex", model: "gpt-5.4" }),
            provider({
              instanceId: claude,
              driver: "claudeAgent",
              model: "claude-sonnet-4-6",
            }),
          ],
          adapterIds: [codex, claude],
        }),
      ),
    ),
  );

  it.effect("falls back to the next candidate when the first is unavailable", () =>
    Effect.gen(function* () {
      const policy = yield* DelegationPolicy.DelegationPolicy;
      assert.deepEqual(yield* policy.resolve("small"), {
        instanceId: claude,
        model: "claude-sonnet-4-6",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          providers: [
            provider({
              instanceId: codex,
              driver: "codex",
              model: "gpt-5.4",
              enabled: false,
            }),
            provider({
              instanceId: claude,
              driver: "claudeAgent",
              model: "claude-sonnet-4-6",
            }),
          ],
          adapterIds: [codex, claude],
        }),
      ),
    ),
  );

  it.effect("rejects an unknown tier", () =>
    Effect.gen(function* () {
      const policy = yield* DelegationPolicy.DelegationPolicy;
      const error = yield* policy.resolve("tiny").pipe(Effect.flip);
      assert.isTrue(DelegationPolicy.isDelegationPolicyError(error));
      if (!DelegationPolicy.isDelegationPolicyError(error)) return;
      assert.equal(error.code, "unknown_tier");
    }).pipe(Effect.provide(makeLayer({ providers: [], adapterIds: [] }))),
  );
});
