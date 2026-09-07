import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import { ExperimentError } from "./Model.ts";
import { assertClean, assertRepository, normalizeApprovedPath, readConfig } from "./Repository.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(configPatch: Readonly<Record<string, unknown>> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "t3-experiment-repository-"));
  roots.push(root);
  execFileSync("git", ["init", "-b", "experiment/test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(path.join(root, "train.py"), "print('one')\n");
  execFileSync("git", ["add", "train.py"], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });
  mkdirSync(path.join(root, ".auto"));
  writeFileSync(
    path.join(root, ".auto/config.json"),
    JSON.stringify({
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
}

describe("experiment repository validation", () => {
  it("accepts the established exact v1 config", async () => {
    const cwd = repo();
    const { config, digest } = await readConfig(cwd);
    assert.strictEqual(digest.length, 64);
    await assertRepository(cwd, config);
    await assertClean(cwd);
  });

  it("rejects unknown config fields and unsafe paths", async () => {
    const cwd = repo({ surprise: true });
    await readConfig(cwd).then(
      () => assert.fail("expected invalid config"),
      (cause: unknown) => assert.instanceOf(cause, ExperimentError),
    );
    assert.throws(() => normalizeApprovedPath("../train.py"), ExperimentError);
    assert.throws(() => normalizeApprovedPath(".auto/config.json"), ExperimentError);
  });

  it("rejects symlinks and protected branches", async () => {
    const symlinkRepo = repo({ files: ["linked.py"] });
    symlinkSync("train.py", path.join(symlinkRepo, "linked.py"));
    await readConfig(symlinkRepo)
      .then(({ config }) => assertRepository(symlinkRepo, config))
      .then(
        () => assert.fail("expected symlink rejection"),
        (cause: unknown) => assert.instanceOf(cause, ExperimentError),
      );

    const protectedRepo = repo({ branch: "main" });
    execFileSync("git", ["branch", "-m", "main"], { cwd: protectedRepo });
    await readConfig(protectedRepo)
      .then(({ config }) => assertRepository(protectedRepo, config))
      .then(
        () => assert.fail("expected protected-branch rejection"),
        (cause: unknown) => assert.instanceOf(cause, ExperimentError),
      );
  });

  it("rejects worktree and index dirt outside .auto", async () => {
    const cwd = repo();
    writeFileSync(path.join(cwd, "train.py"), "print('dirty')\n");
    await assertClean(cwd).then(
      () => assert.fail("expected dirty-worktree rejection"),
      (cause: unknown) => assert.instanceOf(cause, ExperimentError),
    );
  });
});
