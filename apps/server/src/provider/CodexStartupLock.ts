// @effect-diagnostics nodeBuiltinImport:off - The default Codex home is a path on this machine.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { expandHomePath } from "../pathExpansion.ts";

/**
 * The Codex home a spawned `codex app-server` will actually use, following the
 * same precedence as the spawn sites: an explicit setting wins, then an
 * inherited `CODEX_HOME`, then Codex's own default.
 */
export const resolveCodexHomeKey = (input: {
  readonly homePath?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): string => {
  const configured = input.homePath?.trim() || input.environment?.CODEX_HOME?.trim();
  return configured ? expandHomePath(configured) : NodePath.join(NodeOS.homedir(), ".codex");
};

const CODEX_STATE_RUNTIME_FAILURE = "failed to initialize sqlite state runtime";

/** Codex reports the contended state runtime on stderr, several causes deep. */
const mentionsStateRuntimeFailure = (value: unknown, depth = 0): boolean => {
  if (typeof value === "string") {
    return value.toLowerCase().includes(CODEX_STATE_RUNTIME_FAILURE);
  }
  if (depth >= 6 || value === null || typeof value !== "object") return false;
  const nested =
    value instanceof Error ? [value.message, ...Object.values(value)] : Object.values(value);
  return nested.some((entry) => mentionsStateRuntimeFailure(entry, depth + 1));
};

const gates = new Map<string, Semaphore.Semaphore>();

const gateFor = (homeKey: string): Semaphore.Semaphore => {
  const existing = gates.get(homeKey);
  if (existing !== undefined) return existing;
  const gate = Semaphore.makeUnsafe(1);
  gates.set(homeKey, gate);
  return gate;
};

/**
 * Serializes Codex app-server startup per Codex home. Codex opens a sqlite
 * state runtime under `CODEX_HOME` while starting, and two app-servers doing
 * that at once make one of them exit 1, so `startup` must cover the spawn and
 * the `initialize` round-trip that proves the child is up. Startups against
 * different homes, and app-servers already running, stay concurrent.
 *
 * A startup that dies reporting that state runtime is retried once inside the
 * gate: Codex itself or another Codex app can hold the database briefly. The
 * retry spawns a second child, so `startup` must register its own teardown
 * (finalizers for the dead child are no-ops).
 */
export const withCodexStartupLock = <A, E, R>(
  homeKey: string,
  startup: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() =>
    gateFor(homeKey).withPermits(1)(
      Effect.catchIf(startup, mentionsStateRuntimeFailure, () => startup),
    ),
  );
