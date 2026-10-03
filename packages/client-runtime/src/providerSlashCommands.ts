function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

/** Removes provider-advertised commands shadowed by T3's built-in slash commands. */
export function dedupeProviderSlashCommands<T extends { readonly name: string }>(
  providerCommands: ReadonlyArray<T>,
  builtInCommandNames: Iterable<string>,
): ReadonlyArray<T> {
  const builtIns = new Set(Array.from(builtInCommandNames, normalizeCommandName));
  return providerCommands.filter((command) => !builtIns.has(normalizeCommandName(command.name)));
}
