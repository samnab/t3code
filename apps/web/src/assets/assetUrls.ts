import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState,
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetCreateUrlResult, AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl, type AssetUrlState } from "@t3tools/client-runtime/state/assets";

const ASSET_URL_REFRESH_MARGIN_MS = 30_000;

/** Signed asset URLs expire; treat one close to expiry as stale so callers refetch. */
export function isAssetUrlCurrent(
  result: Pick<AssetCreateUrlResult, "expiresAt">,
  now = Date.now(),
): boolean {
  return result.expiresAt - ASSET_URL_REFRESH_MARGIN_MS > now;
}

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const resourceKey = JSON.stringify(resource);
  const stableResource = useMemo(() => resource, [resourceKey]);
  const preparedConnection = usePreparedConnection(environmentId);
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const result = useAtomValue(
    environmentId === null || stableResource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource: stableResource } }),
  );
  const resultIsCurrent = result._tag === "Success" && isAssetUrlCurrent(result.value);
  useEffect(() => {
    if (environmentId === null || stableResource === null) return;
    if (result._tag !== "Success" || resultIsCurrent) return;
    void refresh({ environmentId, input: { resource: stableResource } });
  }, [environmentId, refresh, stableResource, result, resultIsCurrent]);
  if (result._tag === "Success" && !resultIsCurrent) return { _tag: "Loading" };
  return assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<void> {
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null) return;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  }, [environmentId, resource, refresh]);
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  useEffect(() => {
    const expiredResources = resources.filter((_, index) => {
      const result = results[index];
      return result?._tag === "Success" && !isAssetUrlCurrent(result.value);
    });
    if (expiredResources.length === 0) return;
    void Promise.all(
      expiredResources.map((resource) => refresh({ environmentId, input: { resource } })),
    );
  }, [environmentId, refresh, resources, results]);
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result) && isAssetUrlCurrent(result.value)
              ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
              : null,
          ),
    [preparedConnection, resources, results],
  );
}
