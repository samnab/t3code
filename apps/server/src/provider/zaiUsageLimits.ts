// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off
/**
 * z.ai (GLM) subscription usage, read from the same quota endpoint the z.ai
 * dashboard uses. Pi runs GLM through the user's z.ai key but reports no usage
 * of its own, so the server polls once per Pi session start and once per turn,
 * behind a five-minute cache.
 *
 * Never fails: every error path yields an empty window list so the turn path
 * is untouched. Deliberately a plain promise island — it needs no Effect
 * services, so it stays out of the adapter's requirement set.
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { normalizeZaiQuota } from "./usageLimits.ts";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const TIMEOUT_MS = 5_000;
const CACHE_MS = 5 * 60_000;

let cache: {
  readonly at: number;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
} | null = null;

/** Pi stores third-party provider keys in its own auth file. */
async function readZaiKey(): Promise<string | null> {
  try {
    const raw = await NodeFSP.readFile(
      NodePath.join(NodeOS.homedir(), ".pi", "agent", "auth.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    const entry =
      parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).zai : null;
    const key = entry && typeof entry === "object" ? (entry as Record<string, unknown>).key : null;
    return typeof key === "string" && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

async function fetchWindows(): Promise<ReadonlyArray<ServerProviderUsageWindow>> {
  const now = Date.now();
  if (cache !== null && now - cache.at < CACHE_MS) {
    return cache.windows;
  }
  const key = await readZaiKey();
  if (key === null) return [];
  try {
    const response = await fetch(QUOTA_URL, {
      headers: { Authorization: key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const windows = normalizeZaiQuota(await response.json());
    cache = { at: Date.now(), windows };
    return windows;
  } catch {
    return [];
  }
}

/** Cached z.ai usage windows, or `[]` when no key is configured or the call fails. */
export const zaiUsageLimitWindows: Effect.Effect<ReadonlyArray<ServerProviderUsageWindow>> =
  Effect.promise(fetchWindows);

/** Test seam: drops the module-level freshness cache. */
export function resetZaiUsageLimitCache(): void {
  cache = null;
}
