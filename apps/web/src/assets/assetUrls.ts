import { useAtomValue } from "@effect/atom-react";
import {
  type AssetUrlState,
  assetUrlStateFromResult,
  EMPTY_ASSET_URL_ATOM,
  resolveAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AssetCreateUrlResult, AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { assetEnvironment } from "~/state/assets";
import { useFilesystemReadAccess } from "~/state/filesystem";
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
  const fileAccess = useFilesystemReadAccess(environmentId);
  const canReadResource =
    fileAccess.canReadFiles ||
    (stableResource?._tag !== "workspace-file" &&
      stableResource?._tag !== "media-file" &&
      stableResource?._tag !== "draft-workspace-file");
  const preparedConnection = usePreparedConnection(environmentId);
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const result = useAtomValue(
    !canReadResource || environmentId === null || stableResource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource: stableResource } }),
  );
  const resultIsCurrent = result._tag === "Success" && isAssetUrlCurrent(result.value);
  useEffect(() => {
    if (environmentId === null || stableResource === null) return;
    if (result._tag !== "Success" || resultIsCurrent) return;
    void refresh({ environmentId, input: { resource: stableResource } });
  }, [environmentId, refresh, stableResource, result, resultIsCurrent]);
  if (!canReadResource) return { _tag: fileAccess.isPending ? "Loading" : "Failure" };
  if (result._tag === "Success" && !resultIsCurrent) return { _tag: "Loading" };
  return assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
}

export function useAssetUrlRefresh(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const result = await refresh({ environmentId, input: { resource } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
  }, [environmentId, resource, refresh, httpBaseUrl]);
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
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const allowedResources = useMemo(
    () =>
      canReadFiles
        ? resources
        : resources.filter(
            (resource) =>
              resource._tag !== "workspace-file" &&
              resource._tag !== "media-file" &&
              resource._tag !== "draft-workspace-file",
          ),
    [canReadFiles, resources],
  );
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources: allowedResources,
    }),
  );
  useEffect(() => {
    const expiredResources = allowedResources.filter((_, index) => {
      const result = results[index];
      return result?._tag === "Success" && !isAssetUrlCurrent(result.value);
    });
    if (expiredResources.length === 0) return;
    void Promise.all(
      expiredResources.map((resource) => refresh({ environmentId, input: { resource } })),
    );
  }, [allowedResources, environmentId, refresh, results]);
  return useMemo(() => {
    if (preparedConnection._tag === "None") return resources.map(() => null);
    let resultIndex = 0;
    return resources.map((resource) => {
      if (
        !canReadFiles &&
        (resource._tag === "workspace-file" ||
          resource._tag === "media-file" ||
          resource._tag === "draft-workspace-file")
      )
        return null;
      const result = results[resultIndex++];
      return result && AsyncResult.isSuccess(result) && isAssetUrlCurrent(result.value)
        ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
        : null;
    });
  }, [canReadFiles, preparedConnection, resources, results]);
}
