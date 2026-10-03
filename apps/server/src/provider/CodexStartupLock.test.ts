import { assert, it } from "@effect/vitest";
import { CodexAppServerProcessExitedError } from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { resolveCodexHomeKey, withCodexStartupLock } from "./CodexStartupLock.ts";

const HOME = "/tmp/codex-startup-lock-home";

interface StartupProbe {
  readonly startup: (label: string) => Effect.Effect<string>;
  readonly trace: Effect.Effect<ReadonlyArray<string>>;
  readonly peak: Effect.Effect<number>;
}

/**
 * A fake app-server startup that yields to the scheduler while "inside", the
 * way a real spawn plus `initialize` round-trip does. `peak` is the highest
 * number of startups that were inside at once.
 */
const makeStartupProbe = Effect.fnUntraced(function* () {
  const trace = yield* Ref.make<ReadonlyArray<string>>([]);
  const inside = yield* Ref.make(0);
  const peak = yield* Ref.make(0);
  const startup = (label: string) =>
    Effect.gen(function* () {
      const active = yield* Ref.updateAndGet(inside, (count) => count + 1);
      yield* Ref.update(peak, (highest) => Math.max(highest, active));
      yield* Ref.update(trace, (entries) => [...entries, `start:${label}`]);
      // Three turns of the run loop: any unserialized startup lands here.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Ref.update(inside, (count) => count - 1);
      yield* Ref.update(trace, (entries) => [...entries, `up:${label}`]);
      return label;
    });
  return { startup, trace: Ref.get(trace), peak: Ref.get(peak) } satisfies StartupProbe;
});

it.effect("runs two startups against one Codex home one after another", () =>
  Effect.gen(function* () {
    const probe = yield* makeStartupProbe();

    const started = yield* Effect.all(
      [
        withCodexStartupLock(HOME, probe.startup("first")),
        withCodexStartupLock(HOME, probe.startup("second")),
      ],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(started, ["first", "second"]);

    assert.strictEqual(yield* probe.peak, 1);
    assert.deepStrictEqual(yield* probe.trace, [
      "start:first",
      "up:first",
      "start:second",
      "up:second",
    ]);
  }),
);

it.effect("lets startups against different Codex homes overlap", () =>
  Effect.gen(function* () {
    const probe = yield* makeStartupProbe();

    yield* Effect.all(
      [
        withCodexStartupLock(`${HOME}-first`, probe.startup("first")),
        withCodexStartupLock(`${HOME}-second`, probe.startup("second")),
      ],
      { concurrency: "unbounded" },
    );

    // Already-running app-servers must not wait on each other's startup.
    assert.strictEqual(yield* probe.peak, 2);
  }),
);

const exitedWith = (stderr: string) =>
  new CodexAppServerProcessExitedError({ code: 1, pid: 4242, stderr });

const contendedStateRuntime = exitedWith(
  "Error: failed to initialize sqlite state runtime under /Users/dev/.codex: failed to initialize state runtime at /Users/dev/.codex",
);

it.effect("retries a startup that died on the contended state runtime once", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const startup = Effect.gen(function* () {
      const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);
      if (attempt === 1) {
        // The spawn error the adapter wraps the client failure in.
        return yield* Effect.fail({ _tag: "open-session", cause: contendedStateRuntime });
      }
      return "up";
    });

    const result = yield* withCodexStartupLock(`${HOME}-retry`, startup);
    assert.strictEqual(result, "up");
    assert.strictEqual(yield* Ref.get(attempts), 2);
  }),
);

it.effect("does not retry a startup that died for another reason", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const failure = exitedWith("Error: no such subcommand: app-server");
    const startup = Effect.gen(function* () {
      yield* Ref.update(attempts, (count) => count + 1);
      return yield* failure;
    });

    const result = yield* Effect.exit(withCodexStartupLock(`${HOME}-no-retry`, startup));
    assert.isTrue(result._tag === "Failure");
    assert.strictEqual(yield* Ref.get(attempts), 1);
  }),
);

it("keys the gate on the home the app-server will use", () => {
  assert.strictEqual(
    resolveCodexHomeKey({ homePath: " /opt/codex-home ", environment: { CODEX_HOME: "/ignored" } }),
    "/opt/codex-home",
  );
  assert.strictEqual(
    resolveCodexHomeKey({ homePath: "", environment: { CODEX_HOME: "/env/codex" } }),
    "/env/codex",
  );
  assert.isTrue(resolveCodexHomeKey({ environment: {} }).endsWith("/.codex"));
});
