import type { ModelSelection, ServerProvider, ServerSettings } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

/**
 * Agent-facing model visibility. `providerModelPreferences` (server
 * settings) hides models per provider instance; every surface an agent can
 * drive — `orchestrator_capabilities`, `delegate_task`, `create_threads`,
 * `t3_thread_launch` — routes through this one module so capabilities can
 * never advertise what dispatch would reject. Custom models are never
 * hidden (the web client treats them as unhideable too).
 */

/** Slugs hidden for one provider instance. */
export function hiddenModelSlugs(
  settings: Pick<ServerSettings, "providerModelPreferences">,
  instanceId: ProviderInstanceId,
): ReadonlySet<string> {
  return new Set(settings.providerModelPreferences[instanceId]?.hiddenModels ?? []);
}

/** Models of one provider an agent may see or pick. */
export function visibleProviderModels(
  provider: Pick<ServerProvider, "models">,
  hidden: ReadonlySet<string>,
): ReadonlyArray<ServerProvider["models"][number]> {
  return provider.models.filter((model) => model.isCustom || !hidden.has(model.slug));
}

/**
 * Why `selection` names a model the user hid, or null when it is visible
 * (or the provider does not list the model, in which case advertisement
 * checks own the verdict — mirroring how option validation skips
 * unlisted models).
 */
export function hiddenModelMessage(input: {
  readonly settings: Pick<ServerSettings, "providerModelPreferences">;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
}): string | null {
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.selection.instanceId,
  );
  if (provider === undefined || provider.models.length === 0) return null;
  const model = provider.models.find((candidate) => candidate.slug === input.selection.model);
  if (model === undefined || model.isCustom) return null;
  if (!hiddenModelSlugs(input.settings, input.selection.instanceId).has(model.slug)) return null;
  return `Model ${model.slug} is hidden on provider instance ${input.selection.instanceId} (Settings → Providers). Unhide it there or pick a model from orchestrator_capabilities.`;
}
