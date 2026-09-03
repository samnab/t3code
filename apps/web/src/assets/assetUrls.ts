import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetCreateUrlResult, AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

const ASSET_URL_REFRESH_MARGIN_MS = 30_000;

export function isAssetUrlCurrent(
  result: Pick<AssetCreateUrlResult, "expiresAt">,
  now = Date.now(),
): boolean {
  return result.expiresAt - ASSET_URL_REFRESH_MARGIN_MS > now;
}

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly url: string; readonly sourcePath?: string };

export function useAssetUrlState(
  environmentId: EnvironmentId,
  resource: AssetResource,
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
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: stableResource },
    }),
  );
  const resultIsCurrent = result._tag === "Success" && isAssetUrlCurrent(result.value);
  useEffect(() => {
    if (result._tag !== "Success" || resultIsCurrent) return;
    void refresh({ environmentId, input: { resource: stableResource } });
  }, [environmentId, refresh, stableResource, result, resultIsCurrent]);
  if (result._tag === "Failure") {
    return { _tag: "Failure" };
  }
  if (preparedConnection._tag === "None" || result._tag !== "Success" || !resultIsCurrent) {
    return { _tag: "Loading" };
  }
  const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
  return url === null
    ? { _tag: "Failure" }
    : {
        _tag: "Success",
        url,
        ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
      };
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const result = useAssetUrlState(environmentId, resource);
  if (result._tag !== "Success") {
    return null;
  }
  return result.url;
}

/** Re-mints an exact-file capability after a file change or an explicit retry. */
export function useAssetUrlRefresh(
  environmentId: EnvironmentId,
  resource: AssetResource,
): () => Promise<void> {
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
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
