import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  decodeExperimentConfig,
  ExperimentError,
  MAX_CONFIG_BYTES,
  MAX_LEDGER_RECORD_BYTES,
  type ExperimentConfig,
  type FileSnapshot,
} from "./Model.ts";

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

function fail(
  code: ConstructorParameters<typeof ExperimentError>[0]["code"],
  message: string,
  cause?: unknown,
): never {
  throw new ExperimentError({ code, message, ...(cause === undefined ? {} : { cause }) });
}

function realPath(existingPath: string): string {
  return realpathSync.native(existingPath);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  return normalize(left) === normalize(right);
}

export function normalizeApprovedPath(rawPath: string): string {
  const slashPath = rawPath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(slashPath);
  if (
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    path.isAbsolute(rawPath) ||
    path.posix.isAbsolute(normalized) ||
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

function assertRealDirectory(directory: string, label: string): void {
  if (!existsSync(directory)) fail("unsafe_repository", `${label} does not exist.`);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail("unsafe_repository", `${label} must be a real directory, not a symlink.`);
  }
}

function assertRealDirectoryChain(root: string, directory: string, label: string): void {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("unsafe_repository", `${label} escapes the repository.`);
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assertRealDirectory(current, `${label} component ${part}`);
  }
}

export function resolveApprovedFile(cwd: string, relativePath: string): string {
  const normalized = normalizeApprovedPath(relativePath);
  const root = realPath(cwd);
  const absolute = path.resolve(root, normalized);
  assertRealDirectoryChain(root, path.dirname(absolute), `Approved path ${normalized}`);
  if (!existsSync(absolute)) {
    fail("unsafe_repository", `Approved path must already be a regular file: ${normalized}.`);
  }
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("unsafe_repository", `Approved path must be a regular non-symlink file: ${normalized}.`);
  }
  return absolute;
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function terminateGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    // The exact process group launched here already exited.
  }
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
  input?: string,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      detached: true,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const capture = (target: Array<Buffer>, chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= GIT_OUTPUT_CAP) target.push(chunk);
      if (outputBytes > GIT_OUTPUT_CAP) terminateGroup(child.pid, "SIGTERM");
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    if (input !== undefined) child.stdin?.end(input);
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateGroup(child.pid, "SIGTERM");
      setTimeout(() => terminateGroup(child.pid, "SIGKILL"), 1_000).unref?.();
    }, GIT_TIMEOUT_MS);
    timeout.unref?.();
    const finish = (code: number | null, cause?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (cause !== undefined) {
        reject(gitFailure("unsafe_repository", `git ${args[0] ?? "command"} failed.`, cause));
        return;
      }
      if (timedOut || outputBytes > GIT_OUTPUT_CAP || (result.code !== 0 && !allowFailure)) {
        const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-2_000);
        reject(
          gitFailure(
            "unsafe_repository",
            `git ${args[0] ?? "command"} failed (${timedOut ? "timeout" : result.code}): ${detail}`,
          ),
        );
        return;
      }
      resolve(result);
    };
    child.once("error", (cause) => finish(null, cause));
    child.once("close", (code) => finish(code));
  });
}

export const currentHead = async (cwd: string): Promise<string> =>
  (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
export const currentBranch = async (cwd: string): Promise<string> =>
  (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();

function nulPaths(output: string): Array<string> {
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}

export async function stagedPaths(cwd: string): Promise<Array<string>> {
  return nulPaths((await git(cwd, ["diff", "--cached", "--name-only", "-z", "--"])).stdout).sort();
}

export async function changedPaths(cwd: string): Promise<Array<string>> {
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", "-z", "HEAD", "--"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]),
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
  assertRealDirectory(cwd, "Repository root");
  const physicalRoot = realPath(cwd);
  const topLevel = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!samePath(physicalRoot, realPath(topLevel))) {
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
    const absolute = resolveApprovedFile(cwd, file);
    const physical = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    if (physicalFiles.has(physical))
      fail("unsafe_repository", `Approved path aliases another file: ${file}.`);
    physicalFiles.add(physical);
  }
}

export async function readConfig(
  cwd: string,
): Promise<{ readonly config: ExperimentConfig; readonly digest: string }> {
  const auto = path.join(cwd, ".auto");
  assertRealDirectory(auto, ".auto");
  const file = path.join(auto, "config.json");
  if (!existsSync(file)) fail("invalid_config", `Missing ${CONFIG_PATH}.`);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
    fail(
      "invalid_config",
      `${CONFIG_PATH} must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes.`,
    );
  }
  const bytes = await readFile(file);
  try {
    const config = decodeExperimentConfig(JSON.parse(bytes.toString("utf8")));
    return { config, digest: createHash("sha256").update(bytes).digest("hex") };
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
  resolveApprovedFile(cwd, relativePath);
  return (await git(cwd, ["hash-object", "--", relativePath])).stdout.trim();
}

export async function hashContent(cwd: string, content: string): Promise<string> {
  return (await git(cwd, ["hash-object", "--stdin"], false, content)).stdout.trim();
}

export async function snapshotFiles(
  cwd: string,
  paths: ReadonlyArray<string>,
): Promise<Array<FileSnapshot>> {
  return Promise.all(
    paths.map(async (relativePath) => {
      const absolute = resolveApprovedFile(cwd, relativePath);
      const [info, content, hash] = await Promise.all([
        stat(absolute),
        readFile(absolute),
        fileHash(cwd, relativePath),
      ]);
      return {
        path: relativePath,
        contentBase64: content.toString("base64"),
        mode: info.mode & 0o777,
        hash,
      };
    }),
  );
}

export async function writeFileAtomically(
  absolute: string,
  content: Buffer,
  mode: number,
): Promise<void> {
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.t3-experiment-${process.pid}-${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content, { mode, flag: "wx" });
  await rename(temporary, absolute);
  await chmod(absolute, mode);
}

export async function restoreSnapshot(cwd: string, snapshot: FileSnapshot): Promise<void> {
  const absolute = resolveApprovedFile(cwd, snapshot.path);
  await writeFileAtomically(absolute, Buffer.from(snapshot.contentBase64, "base64"), snapshot.mode);
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
): Promise<string> {
  await git(cwd, ["add", "--", ...files]);
  const [staged, changed] = await Promise.all([stagedPaths(cwd), changedPaths(cwd)]);
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
  await git(cwd, [
    "commit",
    "-m",
    `experiment: ${subject || "qualifying improvement"}`,
    "-m",
    `Experiment-Metric: ${metricName}=${metric}`,
  ]);
  return currentHead(cwd);
}

async function ensureChildDirectory(parent: string, name: string): Promise<string> {
  assertRealDirectory(parent, parent);
  const child = path.join(parent, name);
  if (!existsSync(child)) await mkdir(child, { mode: 0o700 });
  assertRealDirectory(child, child);
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
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(
    ledgerPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail("unsafe_repository", "Experiment ledger is not a regular file.");
    await handle.write(record);
  } finally {
    await handle.close();
  }
}
