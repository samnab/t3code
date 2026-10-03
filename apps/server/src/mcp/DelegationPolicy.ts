import {
  type DelegationCandidate,
  DelegationTierId,
  isProviderAvailable,
  type ModelSelection,
  type ServerSettingsError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

export class DelegationPolicyError extends Schema.TaggedError<DelegationPolicyError>()(
  "DelegationPolicyError",
  {
    code: Schema.Literals(["unknown_tier", "no_available_candidate"]),
    message: Schema.String,
  },
) {}
export const isDelegationPolicyError = Schema.is(DelegationPolicyError);

export interface DelegationCandidateHeadroomShape {
  readonly allows: (candidate: DelegationCandidate) => Effect.Effect<boolean>;
}

/** Optimizer-owned quota policy seam. The base server does not filter on headroom. */
export class DelegationCandidateHeadroom extends Context.Service<
  DelegationCandidateHeadroom,
  DelegationCandidateHeadroomShape
>()("t3/mcp/DelegationPolicy/DelegationCandidateHeadroom") {
  static readonly allowAll = Layer.succeed(
    DelegationCandidateHeadroom,
    DelegationCandidateHeadroom.of({ allows: () => Effect.succeed(true) }),
  );
}

export interface DelegationPolicyShape {
  readonly resolve: (
    tier: string,
  ) => Effect.Effect<ModelSelection, DelegationPolicyError | ServerSettingsError>;
}

export class DelegationPolicy extends Context.Service<DelegationPolicy, DelegationPolicyShape>()(
  "t3/mcp/DelegationPolicy",
) {}

function providerUnavailableReason(
  provider: ServerProvider | undefined,
  orchestrationCapable: boolean,
): string | undefined {
  if (provider === undefined) return "provider instance is not registered";
  if (!orchestrationCapable) return "no V2 provider adapter is registered";
  if (!provider.enabled) return "provider instance is disabled";
  if (!provider.installed) return "provider executable is not installed";
  if (!isProviderAvailable(provider)) {
    return provider.unavailableReason ?? "provider driver is unavailable";
  }
  if (provider.status === "error" || provider.status === "disabled") {
    return provider.message ?? `provider status is ${provider.status}`;
  }
  if (provider.auth.status === "unauthenticated") return "provider is not authenticated";
  return undefined;
}

export const layer = Layer.effect(
  DelegationPolicy,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const headroom = yield* DelegationCandidateHeadroom;

    return DelegationPolicy.of({
      resolve: Effect.fn("DelegationPolicy.resolve")(function* (tier) {
        if (!Schema.is(DelegationTierId)(tier)) {
          return yield* new DelegationPolicyError({
            code: "unknown_tier",
            message: `Unknown delegation tier "${tier}".`,
          });
        }
        const configured = (yield* settings.getSettings).delegationTiers[tier];
        const providerSnapshots = yield* providers.getProviders;
        const orchestrationCapable = new Set(yield* adapters.list());
        const reasons: string[] = [];

        for (const candidate of configured) {
          const provider = providerSnapshots.find(
            (entry) => entry.instanceId === candidate.providerInstanceId,
          );
          const unavailable = providerUnavailableReason(
            provider,
            orchestrationCapable.has(candidate.providerInstanceId),
          );
          if (unavailable !== undefined) {
            reasons.push(`${candidate.providerInstanceId}/${candidate.model}: ${unavailable}`);
            continue;
          }
          if (
            provider !== undefined &&
            provider.models.length > 0 &&
            !provider.models.some((model) => model.slug === candidate.model)
          ) {
            reasons.push(
              `${candidate.providerInstanceId}/${candidate.model}: model is not advertised`,
            );
            continue;
          }
          if (!(yield* headroom.allows(candidate))) {
            reasons.push(
              `${candidate.providerInstanceId}/${candidate.model}: headroom policy denied`,
            );
            continue;
          }
          return candidate.options === undefined
            ? { instanceId: candidate.providerInstanceId, model: candidate.model }
            : {
                instanceId: candidate.providerInstanceId,
                model: candidate.model,
                options: candidate.options,
              };
        }

        const detail = configured.length === 0 ? "no candidates configured" : reasons.join("; ");
        return yield* new DelegationPolicyError({
          code: "no_available_candidate",
          message: `Delegation tier "${tier}" has no available candidate (${detail}).`,
        });
      }),
    });
  }),
);

export const layerLive = layer.pipe(Layer.provide(DelegationCandidateHeadroom.allowAll));
