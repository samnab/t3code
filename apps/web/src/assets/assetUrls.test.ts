import {
  AuthFilesystemReadScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ThreadId,
  type AssetResource,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  phase: "connected" as "connected" | "offline",
  assetAtom: {},
  mint: vi.fn(),
  assetQuery: vi.fn(),
}));

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: () => undefined,
  useMemo: <A>(factory: () => A) => factory(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === state.assetAtom
      ? AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: FAR_FUTURE })
      : AsyncResult.initial(false),
}));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("~/state/filesystem", async () => {
  const { resolveFilesystemReadAccess } = await import("@t3tools/client-runtime/state/filesystem");
  return {
    useFilesystemReadAccess: () =>
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: state.phase, error: null },
        session: state.session,
        sessionError: null,
      }),
  };
});
vi.mock("~/state/assets", () => ({
  assetEnvironment: { createUrl: state.assetQuery },
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));

import {
  isAssetUrlCurrent,
  makeRevisionedAssetUrlFamily,
  useAssetUrlRefresh,
  useAssetUrlState,
} from "./assetUrls";

// Year 3000: never expires during a test run.
const FAR_FUTURE = 32_503_680_000_000;
const environmentId = EnvironmentId.make("asset-environment");
const threadId = ThreadId.make("asset-thread");
const resource = { _tag: "media-file", threadId, path: "/repo/image.png" } as const;

beforeEach(() => {
  state.session = null;
  state.phase = "connected";
  state.assetQuery.mockReset().mockReturnValue(state.assetAtom);
  state.mint
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ relativeUrl: "/api/assets/image.png", expiresAt: FAR_FUTURE }),
    );
});

it.each(["workspace-file", "media-file"] as const)(
  "keeps %s loading until its file grant resolves",
  (_tag) => {
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({ _tag: "Loading" });
    expect(state.assetQuery).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(useAssetUrlState(environmentId, { ...resource, _tag })).toEqual({
      _tag: "Success",
      expiresAt: FAR_FUTURE,
      url: "https://host.test/api/assets/image.png",
    });
  },
);

it("hides host assets with a denied grant while preserving attachments", () => {
  state.session = { authenticated: true, scopes: [] };
  expect(useAssetUrlState(environmentId, resource)).toEqual({
    _tag: "Failure",
    reason: "missing-file-access",
  });
  expect(state.assetQuery).not.toHaveBeenCalled();
  expect(useAssetUrlState(environmentId, { _tag: "attachment", attachmentId: "upload" })).toEqual({
    _tag: "Success",
    expiresAt: FAR_FUTURE,
    url: "https://host.test/api/assets/image.png",
  });
});

it("stops waiting for an unresolved grant when the connection is offline", () => {
  state.phase = "offline";
  expect(useAssetUrlState(environmentId, resource)).toEqual({ _tag: "Failure" });
  expect(state.assetQuery).not.toHaveBeenCalled();
});

it("lets the server authorize an explicit refresh before the client grant loads", async () => {
  await expect(useAssetUrlRefresh(environmentId, resource)()).resolves.toBe(
    "https://host.test/api/assets/image.png",
  );
  expect(state.mint).toHaveBeenCalledWith({ environmentId, input: { resource } });

  const denied = new EnvironmentAuthorizationError({
    message: "This connection cannot read host files.",
    requiredScope: AuthFilesystemReadScope,
  });
  state.mint.mockResolvedValue(AsyncResult.failure(Cause.fail(denied)));
  await expect(useAssetUrlRefresh(environmentId, resource)()).rejects.toBe(denied);
});

describe("isAssetUrlCurrent", () => {
  it("rejects an expired cached capability when a chat remounts", () => {
    expect(isAssetUrlCurrent({ expiresAt: 1_000 }, 1_001)).toBe(false);
  });

  it("renews before the cached capability expires", () => {
    expect(isAssetUrlCurrent({ expiresAt: 31_001 }, 1_000)).toBe(true);
    expect(isAssetUrlCurrent({ expiresAt: 31_000 }, 1_000)).toBe(false);
  });
});

const revisionedEnvironmentId = EnvironmentId.make("environment-1");
const revisionedResource: AssetResource = {
  _tag: "workspace-file",
  threadId: ThreadId.make("thread-1"),
  path: "docs/diagram.png",
};

type MintResult = AsyncResult.AsyncResult<{ relativeUrl: string; expiresAt: number }>;

const minted = (n: number): MintResult =>
  AsyncResult.success({ relativeUrl: `/a/${n}`, expiresAt: 0 });

// A stand-in for the asset URL query: a refresh starts a mint (counted, shown as
// waiting) and `settle` completes the latest one.
function setup(initial: MintResult) {
  let mints = 0;
  // Node removal runs on the registry's scheduler; `unmount` flushes it so the
  // next mount of the same revision builds a fresh node.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const server = Atom.make(initial).pipe(Atom.keepAlive);
  const query = Atom.readable(
    (get) => get(server),
    () => {
      mints += 1;
      registry.set(server, AsyncResult.waiting(registry.get(server)));
    },
  ).pipe(Atom.keepAlive);
  const revisioned = makeRevisionedAssetUrlFamily(() => query);
  const mount = (revision: string | null) => {
    const release = registry.mount(
      revisioned({
        environmentId: revisionedEnvironmentId,
        input: { resource: revisionedResource },
        revision,
      }),
    );
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  const settle = () => registry.set(server, minted(mints + 1));
  return { mount, settle, mints: () => mints };
}

describe("makeRevisionedAssetUrlFamily", () => {
  it("re-mints a settled URL on first read and on each new revision, not on remount", () => {
    const { mount, settle, mints } = setup(minted(0));

    mount("mutation-1")();
    expect(mints()).toBe(1);
    settle();

    mount("mutation-1")();
    expect(mints()).toBe(1);

    mount("mutation-2")();
    expect(mints()).toBe(2);
  });

  it("re-mints when a revert returns to an earlier revision", () => {
    const { mount, settle, mints } = setup(minted(0));

    mount("mutation-a")();
    settle();
    mount("mutation-b")();
    settle();
    expect(mints()).toBe(2);

    const reverted = mount("mutation-a");
    expect(mints()).toBe(3);
    reverted();
  });

  it("shares a mint in flight on the first read", () => {
    const { mount, mints } = setup(AsyncResult.initial(true));

    mount("mutation-1")();
    expect(mints()).toBe(0);
  });

  it("re-mints after a mint that was in flight when the revision changed", () => {
    const { mount, settle, mints } = setup(minted(0));

    const before = mount("mutation-1");
    settle();
    const edited = mount("mutation-2");
    expect(mints()).toBe(2);
    before();

    const stillMinting = mount("mutation-3");
    edited();
    expect(mints()).toBe(2);

    settle();
    expect(mints()).toBe(3);
    settle();
    expect(mints()).toBe(3);
    stillMinting();
  });
});
