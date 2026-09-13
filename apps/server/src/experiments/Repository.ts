import * as NodeCrypto from "node:crypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  decodeExperimentConfig,
  ExperimentError,
  MAX_CONFIG_BYTES,
  MAX_LEDGER_RECORD_BYTES,
  type ExperimentConfig,
  type FileSnapshot,
} from "./Model.ts";
import {
  lstatNoFollow,
  nativeRealPath,
  openNoFollowAppendCreate,
  openNoFollowRead,
  type NativeFileInfo,
} from "./NativeFileAccess.ts";

const CONFIG_PATH = ".auto/config.json";
const GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_CAP = 10_000_000;
const DEFAULT_PROTECTED_BRANCHES = new Set([
  "main",
  "master",
  "trunk",
  "develop",
  "development",
  "production",
  "prod",
]);
const fileSystem = Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)));
const path = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const posixPath = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layerPosix)));

function runEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect);
}

function runScoped<A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect));
}

function fail(
  code: ConstructorParameters<typeof ExperimentError>[0]["code"],
  message: string,
  cause?: unknown,
): never {
  throw new ExperimentError({ code, message, ...(cause === undefined ? {} : { cause }) });
}

function failure(
  code: ConstructorParameters<typeof ExperimentError>[0]["code"],
  message: string,
  cause?: unknown,
): ExperimentError {
  return new ExperimentError({ code, message, ...(cause === undefined ? {} : { cause }) });
}

function realPath(existingPath: string): Promise<string> {
  return Promise.resolve(nativeRealPath(existingPath));
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    HostProcessPlatform.defaultValue() === "win32" ? value.toLowerCase() : value;
  return normalize(left) === normalize(right);
}

export async function canonicalRepositoryPath(cwd: string): Promise<string> {
  try {
    return await realPath(cwd);
  } catch (cause) {
    fail("unsafe_repository", `Repository path is unavailable: ${cwd}.`, cause);
  }
}

export async function repositoryPathsEqual(left: string, right: string): Promise<boolean> {
  return samePath(await canonicalRepositoryPath(left), await canonicalRepositoryPath(right));
}

export function normalizeApprovedPath(rawPath: string): string {
  const slashPath = rawPath.replaceAll("\\", "/");
  const normalized = posixPath.normalize(slashPath);
  if (
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    path.isAbsolute(rawPath) ||
    posixPath.isAbsolute(normalized) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".auto" ||
    normalized.startsWith(".auto/")
  ) {
    fail("unsafe_repository", `Unsafe approved path: ${JSON.stringify(rawPath)}.`);
  }
  return normalized;
}

async function assertRealDirectory(directory: string, label: string): Promise<void> {
  const exists = await runEffect(fileSystem.exists(directory));
  if (!exists) fail("unsafe_repository", `${label} does not exist.`);
  const info = await runEffect(lstatNoFollow(directory));
  if (info.kind !== "directory") {
    fail("unsafe_repository", `${label} must be a real directory, not a symlink.`);
  }
}

async function assertRealDirectoryChain(
  root: string,
  directory: string,
  label: string,
): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("unsafe_repository", `${label} escapes the repository.`);
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await assertRealDirectory(current, `${label} component ${part}`);
  }
}

export async function resolveApprovedFile(cwd: string, relativePath: string): Promise<string> {
  const normalized = normalizeApprovedPath(relativePath);
  const root = await realPath(cwd);
  const absolute = path.resolve(root, normalized);
  await assertRealDirectoryChain(root, path.dirname(absolute), `Approved path ${normalized}`);
  if (!(await runEffect(fileSystem.exists(absolute)))) {
    fail("unsafe_repository", `Approved path must already be a regular file: ${normalized}.`);
  }
  const info = await runEffect(lstatNoFollow(absolute));
  if (info.kind !== "file") {
    fail("unsafe_repository", `Approved path must be a regular non-symlink file: ${normalized}.`);
  }
  return absolute;
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function gitFailure(
  code: ConstructorParameters<typeof ExperimentError>[0]["code"],
  message: string,
  cause?: unknown,
): ExperimentError {
  return new ExperimentError({ code, message, ...(cause === undefined ? {} : { cause }) });
}

/** Runs Git without a shell in its own bounded, cancellable process group. */
export function git(
  cwd: string,
  args: ReadonlyArray<string>,
  allowFailure = false,
  input?: string | Buffer,
  timeoutMs = GIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<GitResult> {
  if (signal?.aborted) {
    return Promise.reject(
      gitFailure("limits_exhausted", `git ${args[0] ?? "command"} was cancelled.`),
    );
  }
  const program = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawned = yield* Effect.result(
      spawner.spawn(
        ChildProcess.make("git", args, {
          cwd,
          detached: true,
          windowsHide: true,
          stdin: input === undefined ? "ignore" : "pipe",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "1 second",
        }),
      ),
    );
    if (Result.isFailure(spawned)) {
      return yield* gitFailure(
        "unsafe_repository",
        `git ${args[0] ?? "command"} failed.`,
        spawned.failure,
      );
    }
    const child = spawned.success;
    const stop = yield* Deferred.make<"timeout" | "cancelled" | "output_limit">();
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    let outputBytes = 0;
    const capture = (target: Array<Buffer>, chunk: Uint8Array) =>
      Effect.sync(() => {
        outputBytes += chunk.byteLength;
        if (outputBytes <= GIT_OUTPUT_CAP) target.push(Buffer.from(chunk));
        if (outputBytes > GIT_OUTPUT_CAP) {
          Deferred.doneUnsafe(stop, Effect.succeed("output_limit"));
        }
      });
    const stdoutFiber = yield* Stream.runForEach(child.stdout, (chunk) =>
      capture(stdout, chunk),
    ).pipe(Effect.forkScoped);
    const stderrFiber = yield* Stream.runForEach(child.stderr, (chunk) =>
      capture(stderr, chunk),
    ).pipe(Effect.forkScoped);
    const stdinFiber = yield* (
      input === undefined
        ? Effect.void
        : Stream.run(
            Stream.make(typeof input === "string" ? Buffer.from(input) : input),
            child.stdin,
          )
    ).pipe(Effect.forkScoped);
    yield* Effect.sleep(Math.max(1, Math.min(GIT_TIMEOUT_MS, timeoutMs))).pipe(
      Effect.andThen(Deferred.succeed(stop, "timeout")),
      Effect.forkScoped,
    );
    if (signal !== undefined) {
      yield* Effect.callback<void>((resume) => {
        if (signal.aborted) {
          resume(Effect.void);
          return;
        }
        const onAbort = () => resume(Effect.void);
        signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
      }).pipe(Effect.andThen(Deferred.succeed(stop, "cancelled")), Effect.forkScoped);
    }
    const outcome = yield* Effect.race(
      Effect.all(
        [
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.catch(() => Effect.succeed(-1)),
          ),
          Fiber.await(stdoutFiber),
          Fiber.await(stderrFiber),
          Fiber.await(stdinFiber),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([code]) => ({ _tag: "Exit" as const, code }))),
      Deferred.await(stop).pipe(Effect.map((reason) => ({ _tag: "Stop" as const, reason }))),
    );
    let code: number;
    let stopReason: "timeout" | "cancelled" | "output_limit" | undefined;
    if (outcome._tag === "Exit") {
      code = outcome.code;
    } else {
      stopReason = outcome.reason;
      code = yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" }).pipe(
        Effect.andThen(child.exitCode),
        Effect.map(Number),
        Effect.catch(() => Effect.succeed(-1)),
      );
      yield* Effect.all(
        [Fiber.await(stdoutFiber), Fiber.await(stderrFiber), Fiber.await(stdinFiber)],
        { concurrency: "unbounded" },
      );
    }
    const result = {
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
    if (stopReason !== undefined || (result.code !== 0 && !allowFailure)) {
      const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-2_000);
      return yield* gitFailure(
        "unsafe_repository",
        `git ${args[0] ?? "command"} failed (${stopReason ?? result.code}): ${detail}`,
      );
    }
    return result;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  return Effect.runPromise(program);
}

export const currentHead = async (
  cwd: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<string> =>
  (await git(cwd, ["rev-parse", "HEAD"], false, undefined, timeoutMs, signal)).stdout.trim();
export const currentBranch = async (cwd: string): Promise<string> =>
  (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();

function nulPaths(output: string): Array<string> {
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}

export async function stagedPaths(
  cwd: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<Array<string>> {
  return nulPaths(
    (
      await git(
        cwd,
        ["diff", "--cached", "--name-only", "-z", "--"],
        false,
        undefined,
        timeoutMs,
        signal,
      )
    ).stdout,
  ).sort();
}

export async function changedPaths(
  cwd: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<Array<string>> {
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", "-z", "HEAD", "--"], false, undefined, timeoutMs, signal),
    git(
      cwd,
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      false,
      undefined,
      timeoutMs,
      signal,
    ),
  ]);
  return [...new Set([...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout)])]
    .filter((entry) => entry !== ".auto" && !entry.startsWith(".auto/"))
    .sort();
}

export async function assertClean(cwd: string): Promise<void> {
  const [staged, changed] = await Promise.all([stagedPaths(cwd), changedPaths(cwd)]);
  if (staged.length > 0 || changed.length > 0) {
    fail(
      "external_drift",
      `Repository must be clean outside .auto/ (index: ${staged.join(", ") || "clean"}; worktree: ${changed.join(", ") || "clean"}).`,
    );
  }
}

export async function assertRepository(
  cwd: string,
  config: ExperimentConfig,
  expectedHead?: string,
): Promise<void> {
  await assertRealDirectory(cwd, "Repository root");
  const physicalRoot = await realPath(cwd);
  const topLevel = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!samePath(physicalRoot, await realPath(topLevel))) {
    fail("unsafe_repository", `Thread cwd must be the Git repository root (${topLevel}).`);
  }
  const branch = await currentBranch(cwd);
  if (branch !== config.branch) {
    fail(
      "external_drift",
      `Current branch does not match config branch ${JSON.stringify(config.branch)}.`,
    );
  }
  if (
    DEFAULT_PROTECTED_BRANCHES.has(branch) ||
    branch.startsWith("release/") ||
    (config.protectedBranches ?? []).includes(branch)
  ) {
    fail(
      "unsafe_repository",
      `Refusing to experiment on protected branch ${JSON.stringify(branch)}.`,
    );
  }
  if (expectedHead !== undefined && (await currentHead(cwd)) !== expectedHead) {
    fail("external_drift", "Git HEAD changed outside the experiment lifecycle.");
  }
  const normalized = config.files.map(normalizeApprovedPath);
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((item, i) => item !== config.files[i])
  ) {
    fail("invalid_config", "Approved paths must be unique and already normalized.");
  }
  const physicalFiles = new Set<string>();
  for (const file of normalized) {
    const absolute = await resolveApprovedFile(cwd, file);
    const physical =
      HostProcessPlatform.defaultValue() === "win32" ? absolute.toLowerCase() : absolute;
    if (physicalFiles.has(physical))
      fail("unsafe_repository", `Approved path aliases another file: ${file}.`);
    physicalFiles.add(physical);
  }
}

export async function readConfig(
  cwd: string,
): Promise<{ readonly config: ExperimentConfig; readonly digest: string }> {
  const auto = path.join(cwd, ".auto");
  await assertRealDirectory(auto, ".auto");
  const file = path.join(auto, "config.json");
  if (!(await runEffect(fileSystem.exists(file))))
    fail("invalid_config", `Missing ${CONFIG_PATH}.`);
  const bytes = await readStableRegularFile(
    file,
    MAX_CONFIG_BYTES,
    "invalid_config",
    `${CONFIG_PATH} must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes.`,
  );
  try {
    const config = decodeExperimentConfig(JSON.parse(bytes.toString("utf8")));
    return { config, digest: NodeCrypto.createHash("sha256").update(bytes).digest("hex") };
  } catch (cause) {
    fail("invalid_config", `${CONFIG_PATH} is invalid.`, cause);
  }
}

export async function assertConfigDigest(
  cwd: string,
  expectedDigest: string,
): Promise<ExperimentConfig> {
  const current = await readConfig(cwd);
  if (current.digest !== expectedDigest)
    fail("external_drift", `${CONFIG_PATH} changed after confirmation.`);
  return current.config;
}

export async function fileHash(cwd: string, relativePath: string): Promise<string> {
  await resolveApprovedFile(cwd, relativePath);
  return (await git(cwd, ["hash-object", "--", relativePath])).stdout.trim();
}

export async function hashContent(cwd: string, content: string): Promise<string> {
  return (await git(cwd, ["hash-object", "--stdin"], false, content)).stdout.trim();
}

async function hashBytes(cwd: string, content: Buffer): Promise<string> {
  return (await git(cwd, ["hash-object", "--stdin"], false, content)).stdout.trim();
}

function sameFileIdentity(
  left: Pick<NativeFileInfo, "dev" | "ino">,
  right: Pick<NativeFileInfo, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readStableRegularFile(
  absolute: string,
  maxBytes: number,
  code: ConstructorParameters<typeof ExperimentError>[0]["code"],
  message: string,
): Promise<Buffer> {
  return runScoped(
    Effect.gen(function* () {
      const handle = yield* openNoFollowRead(absolute);
      const before = yield* handle.stat;
      if (before.kind !== "file" || before.size > maxBytes) return yield* failure(code, message);
      const content = yield* handle.readAll;
      const after = yield* handle.stat;
      const current = yield* lstatNoFollow(absolute);
      if (
        content.byteLength > maxBytes ||
        after.kind !== "file" ||
        !sameFileIdentity(before, after) ||
        !sameFileIdentity(after, current) ||
        before.size !== after.size
      ) {
        return yield* failure(code, message);
      }
      return content;
    }).pipe(Effect.mapError((cause) => failure(code, message, cause))),
  );
}

export async function readApprovedFile(
  cwd: string,
  relativePath: string,
  maxBytes: number,
): Promise<string> {
  const absolute = await resolveApprovedFile(cwd, relativePath);
  const bytes = await readStableRegularFile(
    absolute,
    maxBytes,
    "unsafe_repository",
    `Approved file ${relativePath} is unsafe or exceeds the configured read limit.`,
  );
  return bytes.toString("utf8");
}

export async function assertFileMatches(
  cwd: string,
  relativePath: string,
  expectedHash: string,
  expectedMode?: number,
): Promise<void> {
  const absolute = await resolveApprovedFile(cwd, relativePath);
  await runScoped(
    Effect.gen(function* () {
      const handle = yield* openNoFollowRead(absolute);
      const before = yield* handle.stat;
      const content = yield* handle.readAll;
      const after = yield* handle.stat;
      const current = yield* lstatNoFollow(absolute);
      const actualHash = yield* Effect.promise(() => hashBytes(cwd, content));
      if (
        before.kind !== "file" ||
        !sameFileIdentity(before, after) ||
        !sameFileIdentity(after, current) ||
        (expectedMode !== undefined && (after.mode & 0o777) !== expectedMode) ||
        actualHash !== expectedHash
      ) {
        return yield* failure(
          "external_drift",
          `Owned file ${relativePath} changed during the experiment operation.`,
        );
      }
    }),
  );
}

export async function fileState(
  cwd: string,
  relativePath: string,
): Promise<{ readonly hash: string; readonly mode: number }> {
  const absolute = await resolveApprovedFile(cwd, relativePath);
  return runScoped(
    Effect.gen(function* () {
      const handle = yield* openNoFollowRead(absolute);
      const before = yield* handle.stat;
      const content = yield* handle.readAll;
      const after = yield* handle.stat;
      const current = yield* lstatNoFollow(absolute);
      if (
        before.kind !== "file" ||
        !sameFileIdentity(before, after) ||
        !sameFileIdentity(after, current)
      ) {
        fail("external_drift", `Owned file ${relativePath} changed while it was inspected.`);
      }
      const hash = yield* Effect.promise(() => hashBytes(cwd, content));
      return { hash, mode: after.mode & 0o777 };
    }),
  );
}

export async function snapshotFiles(
  cwd: string,
  paths: ReadonlyArray<string>,
): Promise<Array<FileSnapshot>> {
  return Promise.all(
    paths.map(async (relativePath) => {
      const absolute = await resolveApprovedFile(cwd, relativePath);
      return runScoped(
        Effect.gen(function* () {
          const handle = yield* openNoFollowRead(absolute);
          const before = yield* handle.stat;
          const content = yield* handle.readAll;
          const after = yield* handle.stat;
          const current = yield* lstatNoFollow(absolute);
          if (
            before.kind !== "file" ||
            !sameFileIdentity(before, after) ||
            !sameFileIdentity(after, current)
          ) {
            fail(
              "external_drift",
              `Approved file ${relativePath} changed while it was snapshotted.`,
            );
          }
          const hash = yield* Effect.promise(() => hashBytes(cwd, content));
          yield* Effect.promise(() =>
            assertFileMatches(cwd, relativePath, hash, after.mode & 0o777),
          );
          return {
            path: relativePath,
            contentBase64: content.toString("base64"),
            mode: after.mode & 0o777,
            hash,
          };
        }),
      );
    }),
  );
}

export async function writeFileAtomically(
  absolute: string,
  content: Buffer,
  mode: number,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.t3-experiment-${process.pid}-${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    await runEffect(fileSystem.writeFile(temporary, content, { mode, flag: "wx" }));
    if (beforeRename !== undefined) await beforeRename();
    await runEffect(fileSystem.rename(temporary, absolute));
    await runEffect(fileSystem.chmod(absolute, mode));
  } catch (cause) {
    await runEffect(fileSystem.remove(temporary, { force: true })).catch(() => undefined);
    throw cause;
  }
}

export async function restoreSnapshot(
  cwd: string,
  snapshot: FileSnapshot,
  expectedCurrentHash: string,
  expectedCurrentMode: number,
): Promise<void> {
  const absolute = await resolveApprovedFile(cwd, snapshot.path);
  await writeFileAtomically(
    absolute,
    Buffer.from(snapshot.contentBase64, "base64"),
    snapshot.mode,
    () => assertFileMatches(cwd, snapshot.path, expectedCurrentHash, expectedCurrentMode),
  );
}

export function setEquals(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((entry) => b.has(entry));
}

export async function commitCandidate(
  cwd: string,
  files: ReadonlyArray<string>,
  hypothesis: string,
  metricName: string,
  metric: number,
  options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<string> {
  const deadline = performance.now() + Math.max(1, options.timeoutMs ?? GIT_TIMEOUT_MS);
  const budget = () => {
    if (options.signal?.aborted) fail("limits_exhausted", "Experiment commit was cancelled.");
    const remaining = deadline - performance.now();
    if (remaining <= 0) fail("limits_exhausted", "Experiment commit exceeded its time limit.");
    return remaining;
  };
  await git(cwd, ["add", "--", ...files], false, undefined, budget(), options.signal);
  const [staged, changed] = await Promise.all([
    stagedPaths(cwd, budget(), options.signal),
    changedPaths(cwd, budget(), options.signal),
  ]);
  if (!setEquals(staged, files) || !setEquals(changed, files)) {
    fail(
      "external_drift",
      "The staged candidate differs from the exact approved changed-file set.",
    );
  }
  const subject = hypothesis
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72);
  await git(
    cwd,
    [
      "commit",
      "--only",
      "-m",
      `experiment: ${subject || "qualifying improvement"}`,
      "-m",
      `Experiment-Metric: ${metricName}=${metric}`,
      "--",
      ...files,
    ],
    false,
    undefined,
    budget(),
    options.signal,
  );
  return currentHead(cwd, budget(), options.signal);
}

/** Removes only experiment-owned paths from the index after a rejected commit hook. */
export async function unstageCandidate(cwd: string, files: ReadonlyArray<string>): Promise<void> {
  await git(cwd, ["restore", "--staged", "--", ...files]);
  const owned = new Set(files);
  if ((await stagedPaths(cwd)).some((entry) => owned.has(entry))) {
    fail("external_drift", "Could not remove the experiment candidate from the index.");
  }
}

async function ensureChildDirectory(parent: string, name: string): Promise<string> {
  await assertRealDirectory(parent, parent);
  const child = path.join(parent, name);
  if (!(await runEffect(fileSystem.exists(child)))) {
    await runEffect(fileSystem.makeDirectory(child, { mode: 0o700 }));
  }
  await assertRealDirectory(child, child);
  return child;
}

export async function appendLedger(
  cwd: string,
  runId: string,
  entry: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) fail("unsafe_repository", "Experiment run id is invalid.");
  const auto = path.join(cwd, ".auto");
  const goals = await ensureChildDirectory(auto, "goals");
  const runDirectory = await ensureChildDirectory(goals, runId);
  const ledgerPath = path.join(runDirectory, "ledger.jsonl");
  const record = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
  if (record.byteLength > MAX_LEDGER_RECORD_BYTES) {
    fail("persistence_failed", "Experiment ledger record exceeded its server limit.");
  }
  await runScoped(
    Effect.gen(function* () {
      const handle = yield* openNoFollowAppendCreate(ledgerPath, 0o600).pipe(
        Effect.mapError((cause) =>
          failure("unsafe_repository", "Experiment ledger path is unsafe.", cause),
        ),
      );
      const info = yield* handle.stat;
      if (info.kind !== "file") {
        return yield* new ExperimentError({
          code: "unsafe_repository",
          message: "Experiment ledger is not a regular file.",
        });
      }
      yield* handle.writeAll(record).pipe(
        Effect.mapError(
          (cause) =>
            new ExperimentError({
              code: "persistence_failed",
              message: "Experiment ledger write failed.",
              cause,
            }),
        ),
      );
      yield* handle.sync.pipe(
        Effect.mapError(
          (cause) =>
            new ExperimentError({
              code: "persistence_failed",
              message: "Experiment ledger sync failed.",
              cause,
            }),
        ),
      );
    }),
  );
}
