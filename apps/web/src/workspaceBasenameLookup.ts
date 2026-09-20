// Enough hits to look past same-named neighbours (`ChatView.test.tsx`) without
// asking for a full listing on a single click.
export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// One counter for every caller: they all open the same panel, so the newest
// click wins regardless of which one started the lookup.
let latestLookupSequence = 0;

/** Call the returned predicate when the search settles; false means a later click superseded it. */
export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function normalizeSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Agents write paths relative to wherever they happened to be working
 * (`analysis/forecast/x.xlsx` from inside `2027-Forecast/`), so any relative
 * path is worth checking against the index, not just a bare filename.
 */
export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  return relativePath.trim().length > 0;
}

/**
 * Picks the indexed file for a workspace-relative path: the exact path, else
 * the index's best-ranked file whose path ends with it (a bare name matches
 * on basename).
 */
export function pickWorkspaceBasenameMatch(
  relativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = normalizeSeparators(relativePath.trim()).replace(/^\.?\//, "");
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const endsWith = (path: string, suffix: string) => path === suffix || path.endsWith(`/${suffix}`);
  const exact = files.find((entry) => normalizeSeparators(entry.path) === target);
  if (exact) return exact.path;
  const suffix = files.find((entry) => endsWith(normalizeSeparators(entry.path), target));
  if (suffix) return suffix.path;
  // Folded matching covers casing that drifted from disk, but `FOO.ts` against
  // both `Foo.ts` and `foo.ts` has no right answer, so it resolves to nothing
  // rather than opening whichever the index ranked first.
  const folded = target.toLowerCase();
  const foldedMatches = files.filter((entry) =>
    endsWith(normalizeSeparators(entry.path).toLowerCase(), folded),
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}
