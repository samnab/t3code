import { spawn, type ChildProcess } from "node:child_process";

export type ProcessTermination = "exit" | "timeout" | "output_limit" | "aborted" | "spawn_error";

export interface BoundedProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationSeconds: number;
  readonly termination: ProcessTermination;
}

interface OwnedProcess {
  readonly child: ChildProcess;
  readonly settled: Promise<void>;
  readonly terminate: (reason: ProcessTermination) => void;
}

const COMMAND_ENV_NAMES = new Set([
  "comspec",
  "home",
  "lang",
  "lc_all",
  "lc_ctype",
  "path",
  "pathext",
  "systemroot",
  "temp",
  "tmp",
  "tmpdir",
  "userprofile",
  "windir",
]);

export function commandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && COMMAND_ENV_NAMES.has(name.toLowerCase())) environment[name] = value;
  }
  return environment;
}

function killOwnedProcess(child: ChildProcess, force: boolean): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => killer.kill("SIGKILL"), 5_000);
    timeout.unref?.();
    killer.once("close", () => clearTimeout(timeout));
    killer.unref();
    return;
  }
  try {
    if (child.pid !== undefined) process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    else child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
      // The exact process this registry launched has already exited.
    }
  }
}

/** Owns only subprocess groups created by experiment evaluation. */
export class ExperimentProcessRegistry {
  readonly #runs = new Map<string, Set<OwnedProcess>>();

  run(
    runId: string,
    argv: ReadonlyArray<string>,
    options: {
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<BoundedProcessResult> {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const stdoutChunks: Array<Buffer> = [];
      const stderrChunks: Array<Buffer> = [];
      let capturedBytes = 0;
      let producedBytes = 0;
      let termination: ProcessTermination = "exit";
      let finished = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      let settleOwned = () => {};
      const settled = new Promise<void>((done) => {
        settleOwned = done;
      });

      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: options.cwd,
        detached: true,
        env: commandEnvironment(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const terminate = (reason: ProcessTermination) => {
        if (termination !== "exit") return;
        termination = reason;
        killOwnedProcess(child, false);
        escalation = setTimeout(() => {
          if (!finished) killOwnedProcess(child, true);
        }, 1_000);
        escalation.unref?.();
      };
      const owned: OwnedProcess = { child, settled, terminate };
      const processes = this.#runs.get(runId) ?? new Set<OwnedProcess>();
      processes.add(owned);
      this.#runs.set(runId, processes);

      const capture = (target: Array<Buffer>, chunk: Buffer) => {
        producedBytes += chunk.byteLength;
        const remaining = Math.max(0, options.maxOutputBytes - capturedBytes);
        if (remaining > 0) {
          const kept = chunk.subarray(0, remaining);
          target.push(kept);
          capturedBytes += kept.byteLength;
        }
        if (producedBytes > options.maxOutputBytes) terminate("output_limit");
      };
      child.stdout?.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));

      const timeout = setTimeout(() => terminate("timeout"), Math.max(1, options.timeoutMs));
      timeout.unref?.();
      const onAbort = () => terminate("aborted");
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (escalation !== undefined) clearTimeout(escalation);
        options.signal?.removeEventListener("abort", onAbort);
        processes.delete(owned);
        if (processes.size === 0) this.#runs.delete(runId);
        settleOwned();
        resolve({
          code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          durationSeconds: (performance.now() - startedAt) / 1_000,
          termination,
        });
      };
      child.once("error", (error) => {
        termination = "spawn_error";
        capture(stderrChunks, Buffer.from(error.message));
        finish(null);
      });
      child.once("close", finish);
    });
  }

  async cancel(runId: string): Promise<void> {
    const processes = [...(this.#runs.get(runId) ?? [])];
    for (const process of processes) process.terminate("aborted");
    await Promise.all(processes.map((process) => process.settled));
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((runId) => this.cancel(runId)));
  }
}
