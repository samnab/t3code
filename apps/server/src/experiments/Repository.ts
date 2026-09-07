import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
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
const GIT_TIMEOUT_MS = 10_000;
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

export function git(cwd: string, args: ReadonlyArray<string>, allowFailure = false): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_CAP,
    windowsHide: true,
  });
  if (result.error) fail("unsafe_repository", `git ${args[0] ?? "command"} failed.`, result.error);
  const code = result.status ?? -1;
  if (code !== 0 && !allowFailure) {
    const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().slice(-2_000);
    fail("unsafe_repository", `git ${args[0] ?? "command"} failed (${code}): ${detail}`);
  }
  return { code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export const currentHead = (cwd: string): string => git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
export const currentBranch = (cwd: string): string =>
  git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();

function nulPaths(output: string): Array<string> {
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.replaceAll("\\", "/"));
}

export function stagedPaths(cwd: string): Array<string> {
  return nulPaths(git(cwd, ["diff", "--cached", "--name-only", "-z", "--"]).stdout).sort();
}

export function changedPaths(cwd: string): Array<string> {
  const tracked = nulPaths(git(cwd, ["diff", "--name-only", "-z", "HEAD", "--"]).stdout);
  const untracked = nulPaths(
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"]).stdout,
  );
  return [...new Set([...tracked, ...untracked])]
    .filter((entry) => entry !== ".auto" && !entry.startsWith(".auto/"))
    .sort();
}

export function assertClean(cwd: string): void {
  const staged = stagedPaths(cwd);
  const changed = changedPaths(cwd);
  if (staged.length > 0 || changed.length > 0) {
    fail(
      "external_drift",
      `Repository must be clean outside .auto/ (index: ${staged.join(", ") || "clean"}; worktree: ${changed.join(", ") || "clean"}).`,
    );
  }
}

export function assertRepository(
  cwd: string,
  config: ExperimentConfig,
  expectedHead?: string,
): void {
  assertRealDirectory(cwd, "Repository root");
  const physicalRoot = realPath(cwd);
  const topLevel = git(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (!samePath(physicalRoot, realPath(topLevel))) {
    fail("unsafe_repository", `Thread cwd must be the Git repository root (${topLevel}).`);
  }
  const branch = currentBranch(cwd);
  if (branch !== config.branch) {
    fail(
      "external_drift",
      `Current branch ${JSON.stringify(branch)} does not match config branch ${JSON.stringify(config.branch)}.`,
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
  if (expectedHead !== undefined && currentHead(cwd) !== expectedHead) {
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

export function readConfig(cwd: string): {
  readonly config: ExperimentConfig;
  readonly digest: string;
} {
  const auto = path.join(cwd, ".auto");
  assertRealDirectory(auto, ".auto");
  const file = path.join(auto, "config.json");
  if (!existsSync(file)) fail("invalid_config", `Missing ${CONFIG_PATH}.`);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) {
    fail(
      "invalid_config",
      `${CONFIG_PATH} must be a regular file no larger than ${MAX_CONFIG_BYTES} bytes.`,
    );
  }
  const bytes = readFileSync(file);
  try {
    const config = decodeExperimentConfig(JSON.parse(bytes.toString("utf8")));
    return { config, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch (cause) {
    fail("invalid_config", `${CONFIG_PATH} is invalid.`, cause);
  }
}

export function assertConfigDigest(cwd: string, expectedDigest: string): ExperimentConfig {
  const current = readConfig(cwd);
  if (current.digest !== expectedDigest) {
    fail("external_drift", `${CONFIG_PATH} changed after confirmation.`);
  }
  return current.config;
}

export function fileHash(cwd: string, relativePath: string): string {
  resolveApprovedFile(cwd, relativePath);
  return git(cwd, ["hash-object", "--", relativePath]).stdout.trim();
}

export function hashContent(cwd: string, content: string): string {
  const result = spawnSync("git", ["hash-object", "--stdin"], {
    cwd,
    input: content,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_CAP,
    windowsHide: true,
  });
  if (result.error || result.status !== 0)
    fail("unsafe_repository", "Could not hash candidate content.", result.error);
  return result.stdout.trim();
}

export function snapshotFiles(cwd: string, paths: ReadonlyArray<string>): Array<FileSnapshot> {
  return paths.map((relativePath) => {
    const absolute = resolveApprovedFile(cwd, relativePath);
    const info = statSync(absolute);
    return {
      path: relativePath,
      contentBase64: readFileSync(absolute).toString("base64"),
      mode: info.mode & 0o777,
      hash: fileHash(cwd, relativePath),
    };
  });
}

export function writeFileAtomically(absolute: string, content: Buffer, mode: number): void {
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.t3-experiment-${process.pid}-${randomUUID()}.tmp`,
  );
  writeFileSync(temporary, content, { mode, flag: "wx" });
  renameSync(temporary, absolute);
  chmodSync(absolute, mode);
}

export function restoreSnapshot(cwd: string, snapshot: FileSnapshot): void {
  const absolute = resolveApprovedFile(cwd, snapshot.path);
  writeFileAtomically(absolute, Buffer.from(snapshot.contentBase64, "base64"), snapshot.mode);
}

export function setEquals(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((entry) => b.has(entry));
}

export function commitCandidate(
  cwd: string,
  files: ReadonlyArray<string>,
  hypothesis: string,
  metricName: string,
  metric: number,
): string {
  git(cwd, ["add", "--", ...files]);
  const staged = stagedPaths(cwd);
  const changed = changedPaths(cwd);
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
  git(cwd, [
    "commit",
    "-m",
    `experiment: ${subject || "qualifying improvement"}`,
    "-m",
    `Experiment-Metric: ${metricName}=${metric}`,
  ]);
  return currentHead(cwd);
}

function ensureChildDirectory(parent: string, name: string): string {
  assertRealDirectory(parent, parent);
  const child = path.join(parent, name);
  if (!existsSync(child)) mkdirSync(child, { mode: 0o700 });
  assertRealDirectory(child, child);
  return child;
}

export function appendLedger(
  cwd: string,
  runId: string,
  entry: Readonly<Record<string, unknown>>,
): void {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) fail("unsafe_repository", "Experiment run id is invalid.");
  const auto = path.join(cwd, ".auto");
  const goals = ensureChildDirectory(auto, "goals");
  const runDirectory = ensureChildDirectory(goals, runId);
  const ledgerPath = path.join(runDirectory, "ledger.jsonl");
  const record = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
  if (record.byteLength > MAX_LEDGER_RECORD_BYTES) {
    fail("persistence_failed", "Experiment ledger record exceeded its server limit.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const fd = openSync(
    ledgerPath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
    0o600,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) fail("unsafe_repository", "Experiment ledger is not a regular file.");
    writeSync(fd, record);
  } finally {
    closeSync(fd);
  }
}
