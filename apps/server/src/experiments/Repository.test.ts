import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ExperimentError } from "./Model.ts";
import {
  appendLedger,
  assertClean,
  assertRepository,
  commitCandidate,
  currentHead,
  git,
  normalizeApprovedPath,
  readApprovedFile,
  readConfig,
} from "./Repository.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function repo(configPatch: Readonly<Record<string, unknown>> = {}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-experiment-repository-",
    });
    yield* Effect.promise(() => git(root, ["init", "-b", "experiment/test"]));
    yield* Effect.promise(() => git(root, ["config", "user.email", "test@example.com"]));
    yield* Effect.promise(() => git(root, ["config", "user.name", "Test"]));
    yield* fileSystem.writeFileString(path.join(root, "train.py"), "print('one')\n");
    yield* Effect.promise(() => git(root, ["add", "train.py"]));
    yield* Effect.promise(() => git(root, ["commit", "-m", "fixture"]));
    yield* fileSystem.makeDirectory(path.join(root, ".auto"));
    yield* fileSystem.writeFileString(
      path.join(root, ".auto/config.json"),
      encodeJson({
        version: 1,
        branch: "experiment/test",
        files: ["train.py"],
        evaluator: {
          argv: ["node", "-e", 'console.log(\'{"metrics":{"score":1}}\')'],
          metric: "score",
          direction: "higher",
          minimumImprovement: 0,
        },
        checks: [["node", "--check", "train.py"]],
        limits: {
          maxExperiments: 10,
          maxApplyBytes: 100_000,
          maxOutputBytes: 100_000,
          evaluatorTimeoutSeconds: 60,
          checkTimeoutSeconds: 30,
          maxTotalSeconds: 600,
        },
        ...configPatch,
      }),
    );
    return root;
  });
}

it.layer(NodeServices.layer)("experiment repository validation", (it) => {
  it.effect("accepts the established exact v1 config", () =>
    Effect.gen(function* () {
      const cwd = yield* repo();
      const { config, digest } = yield* Effect.promise(() => readConfig(cwd));
      assert.strictEqual(digest.length, 64);
      yield* Effect.promise(() => assertRepository(cwd, config));
      yield* Effect.promise(() => assertClean(cwd));
    }),
  );

  it.effect("rejects unknown config fields and unsafe paths", () =>
    Effect.gen(function* () {
      const cwd = yield* repo({ surprise: true });
      yield* Effect.promise(() =>
        readConfig(cwd).then(
          () => assert.fail("expected invalid config"),
          (cause: unknown) => assert.instanceOf(cause, ExperimentError),
        ),
      );
      assert.throws(() => normalizeApprovedPath("../train.py"), ExperimentError);
      assert.throws(() => normalizeApprovedPath(".auto/config.json"), ExperimentError);
    }),
  );

  it.effect("rejects symlinks and protected branches", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const symlinkRepo = yield* repo({ files: ["linked.py"] });
      yield* fileSystem.symlink("train.py", path.join(symlinkRepo, "linked.py"));
      yield* Effect.promise(() =>
        readConfig(symlinkRepo)
          .then(({ config }) => assertRepository(symlinkRepo, config))
          .then(
            () => assert.fail("expected symlink rejection"),
            (cause: unknown) => assert.instanceOf(cause, ExperimentError),
          ),
      );

      const protectedRepo = yield* repo({ branch: "main" });
      yield* Effect.promise(() => git(protectedRepo, ["branch", "-m", "main"]));
      yield* Effect.promise(() =>
        readConfig(protectedRepo)
          .then(({ config }) => assertRepository(protectedRepo, config))
          .then(
            () => assert.fail("expected protected-branch rejection"),
            (cause: unknown) => assert.instanceOf(cause, ExperimentError),
          ),
      );
    }),
  );

  it.effect("opens the config itself without following symlinks", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* repo();
      const config = path.join(cwd, ".auto/config.json");
      const target = path.join(cwd, ".auto/config.real.json");
      yield* fileSystem.rename(config, target);
      yield* fileSystem.symlink("config.real.json", config);
      yield* Effect.promise(() =>
        readConfig(cwd).then(
          () => assert.fail("expected config symlink rejection"),
          (cause: unknown) => assert.instanceOf(cause, ExperimentError),
        ),
      );
    }),
  );

  it.effect("rejects a symlink in an approved file directory chain", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* repo();
      const targetDirectory = path.join(cwd, "approved-real");
      yield* fileSystem.makeDirectory(targetDirectory);
      yield* fileSystem.writeFileString(path.join(targetDirectory, "score.txt"), "secret\n");
      yield* fileSystem.symlink("approved-real", path.join(cwd, "approved-link"));

      yield* Effect.promise(() =>
        readApprovedFile(cwd, "approved-link/score.txt", 1_024).then(
          () => assert.fail("expected directory symlink rejection"),
          (cause: unknown) => assert.instanceOf(cause, ExperimentError),
        ),
      );
    }),
  );

  it.effect("rejects a ledger symlink without changing its target", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* repo();
      const runId = "11111111-1111-4111-8111-111111111111";
      const runDirectory = path.join(cwd, ".auto", "goals", runId);
      yield* fileSystem.makeDirectory(runDirectory, { recursive: true });
      const target = path.join(cwd, ".auto", "ledger-target.jsonl");
      yield* fileSystem.writeFileString(target, "sentinel\n");
      yield* fileSystem.symlink(target, path.join(runDirectory, "ledger.jsonl"));

      yield* Effect.promise(() =>
        appendLedger(cwd, runId, { type: "must-not-write" }).then(
          () => assert.fail("expected ledger symlink rejection"),
          (cause: unknown) => assert.instanceOf(cause, ExperimentError),
        ),
      );
      assert.strictEqual(yield* fileSystem.readFileString(target), "sentinel\n");
    }),
  );

  it.effect("rejects worktree and index dirt outside .auto", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* repo();
      yield* fileSystem.writeFileString(path.join(cwd, "train.py"), "print('dirty')\n");
      yield* Effect.promise(() =>
        assertClean(cwd).then(
          () => assert.fail("expected dirty-worktree rejection"),
          (cause: unknown) => assert.instanceOf(cause, ExperimentError),
        ),
      );
    }),
  );

  it.effect("bounds commit hooks by the caller's remaining campaign time", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* repo();
      const before = yield* Effect.promise(() => currentHead(cwd));
      yield* fileSystem.writeFileString(path.join(cwd, "train.py"), "print('better')\n");
      const hook = path.join(cwd, ".git/hooks/pre-commit");
      yield* fileSystem.writeFileString(hook, "#!/bin/sh\nsleep 1\n");
      yield* fileSystem.chmod(hook, 0o755);

      yield* Effect.promise(() =>
        commitCandidate(cwd, ["train.py"], "Improve output", "score", 2, {
          timeoutMs: 50,
        }).then(
          () => assert.fail("expected the commit hook to exceed its campaign budget"),
          (cause: unknown) => assert.instanceOf(cause, ExperimentError),
        ),
      );
      assert.strictEqual(yield* Effect.promise(() => currentHead(cwd)), before);
    }),
  );
});
