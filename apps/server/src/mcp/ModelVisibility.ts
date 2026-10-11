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
  return new Set(settings.providerModelPreferences?.[instanceId]?.hiddenModels ?? []);
}

/** Models of one provider an agent may see or pick. */
export function visibleProviderModels(
  provider: Pick<ServerProvider, "models">,
  hidden: ReadonlySet<string>,
): ReadonlyArray<ServerProvider["models"][number]> {
  return provider.models.filter((model) => model.isCustom || !hidden.has(model.slug));
}

/**
 * Why `selection` names a model the user hid, null when it is visible. Checks the
 * configured hidden list directly so an empty or incomplete catalog (for example
 * failed Pi discovery) cannot let a hidden model through; only a model the
 * catalog marks custom is exempt.
 */
export function hiddenModelMessage(input: {
  readonly settings: Pick<ServerSettings, "providerModelPreferences">;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
}): string | null {
  const { instanceId, model } = input.selection;
  if (!hiddenModelSlugs(input.settings, instanceId).has(model)) return null;
  const listed = input.providers
    .find((candidate) => candidate.instanceId === instanceId)
    ?.models.find((candidate) => candidate.slug === model);
  if (listed?.isCustom === true) return null;
  return `Model ${model} is hidden on provider instance ${instanceId} (Settings → Providers). Unhide it there or pick a model from orchestrator_capabilities.`;
}
