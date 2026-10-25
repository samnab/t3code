import { isAbsolutePath, isWindowsAbsolutePath } from "@t3tools/shared/path";

export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// All callers open one panel; the newest click must win across callers.
let latestLookupSequence = 0;

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
  const trimmed = relativePath.trim();
  return trimmed !== "." && trimmed !== ".." && trimmed.length > 0;
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

// Repository-relative paths can repeat the project's suffix in subfolder projects.
export function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (isAbsolutePath(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsAbsolutePath(cwd)
    ? (segment: string | undefined) => segment?.toLowerCase()
    : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/") || null;
    }
  }
  return null;
}

export function pickStrippedWorkspaceMatch(
  strippedPath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const caseInsensitive = isWindowsAbsolutePath(cwd);
  const key = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const files = entries.filter((entry) => entry.kind === "file");
  return files.find((entry) => key(entry.path) === key(strippedPath))?.path ?? null;
}
