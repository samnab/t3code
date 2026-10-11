import type { ModelSelection, ServerSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

/** Applies the selected provider instance's configured model and options to a carried selection. */
export function resolveConfiguredProviderDefault(
  settings: Pick<ServerSettings, "providerModelPreferences">,
  carriedSelection: ModelSelection,
): ModelSelection {
  const preference = settings.providerModelPreferences?.[carriedSelection.instanceId];
  if (!preference?.defaultModel) return carriedSelection;
  return createModelSelection(
    carriedSelection.instanceId,
    preference.defaultModel,
    preference.defaultOptions,
  );
}

/** Shared new-thread priority: project default, configured provider default, then carried pick. */
export function resolveNewThreadModelSelection(input: {
  readonly projectDefaultSelection: ModelSelection | null;
  readonly carriedSelection: ModelSelection | null;
  readonly shouldCarrySelection: boolean;
  readonly settings: Pick<ServerSettings, "providerModelPreferences">;
}): ModelSelection | null {
  if (input.projectDefaultSelection !== null) return input.projectDefaultSelection;
  if (!input.shouldCarrySelection || input.carriedSelection === null) return null;
  return resolveConfiguredProviderDefault(input.settings, input.carriedSelection);
}
