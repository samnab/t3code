import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type ProcessTermination = "exit" | "timeout" | "output_limit" | "aborted" | "spawn_error";

export interface BoundedProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationSeconds: number;
  readonly termination: ProcessTermination;
}

interface OwnedProcess {
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

function abortEffect(signal: AbortSignal | undefined): Effect.Effect<void> {
  if (signal === undefined) return Effect.never;
  return Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
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
    const startedAt = performance.now();
    let requestedTermination: ProcessTermination | undefined;
    let requestRunningTermination: ((reason: ProcessTermination) => void) | undefined;
    let settleOwned = () => {};
    const settled = new Promise<void>((resolve) => {
      settleOwned = resolve;
    });
    const owned: OwnedProcess = {
      settled,
      terminate: (reason) => {
        if (requestedTermination !== undefined) return;
        requestedTermination = reason;
        requestRunningTermination?.(reason);
      },
    };
    const processes = this.#runs.get(runId) ?? new Set<OwnedProcess>();
    processes.add(owned);
    this.#runs.set(runId, processes);

    const program = Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Effect.result(
        spawner.spawn(
          ChildProcess.make(argv[0]!, argv.slice(1), {
            cwd: options.cwd,
            detached: true,
            windowsHide: true,
            env: commandEnvironment(),
            extendEnv: false,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "1 second",
          }),
        ),
      );
      if (Result.isFailure(spawned)) {
        const stderr = Buffer.from(String(spawned.failure)).subarray(0, options.maxOutputBytes);
        return {
          code: null,
          stdout: "",
          stderr: stderr.toString("utf8"),
          durationSeconds: (performance.now() - startedAt) / 1_000,
          termination: "spawn_error" as const,
        };
      }

      const child = spawned.success;
      const stop = yield* Deferred.make<ProcessTermination>();
      requestRunningTermination = (reason) => {
        Deferred.doneUnsafe(stop, Effect.succeed(reason));
      };
      if (requestedTermination !== undefined) requestRunningTermination(requestedTermination);

      const stdoutChunks: Array<Buffer> = [];
      const stderrChunks: Array<Buffer> = [];
      let capturedBytes = 0;
      let producedBytes = 0;
      const capture = (target: Array<Buffer>, chunk: Uint8Array) =>
        Effect.sync(() => {
          producedBytes += chunk.byteLength;
          const remaining = Math.max(0, options.maxOutputBytes - capturedBytes);
          if (remaining > 0) {
            const kept = Buffer.from(chunk).subarray(0, remaining);
            target.push(kept);
            capturedBytes += kept.byteLength;
          }
          if (producedBytes > options.maxOutputBytes) {
            Deferred.doneUnsafe(stop, Effect.succeed("output_limit"));
          }
        });
      const stdoutFiber = yield* Stream.runForEach(child.stdout, (chunk) =>
        capture(stdoutChunks, chunk),
      ).pipe(Effect.forkScoped);
      const stderrFiber = yield* Stream.runForEach(child.stderr, (chunk) =>
        capture(stderrChunks, chunk),
      ).pipe(Effect.forkScoped);
      yield* Effect.sleep(Math.max(1, options.timeoutMs)).pipe(
        Effect.andThen(Deferred.succeed(stop, "timeout")),
        Effect.forkScoped,
      );
      yield* abortEffect(options.signal).pipe(
        Effect.andThen(Deferred.succeed(stop, "aborted")),
        Effect.forkScoped,
      );

      const outcome = yield* Effect.race(
        Effect.all(
          [
            child.exitCode.pipe(
              Effect.map(Number),
              Effect.catch(() => Effect.succeed(null)),
            ),
            Fiber.await(stdoutFiber),
            Fiber.await(stderrFiber),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([code]) => ({ _tag: "Exit" as const, code }))),
        Deferred.await(stop).pipe(
          Effect.map((termination) => ({ _tag: "Stop" as const, termination })),
        ),
      );
      let code: number | null;
      let termination: ProcessTermination;
      if (outcome._tag === "Exit") {
        code = outcome.code;
        termination = "exit";
      } else {
        termination = outcome.termination;
        code = yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" }).pipe(
          Effect.andThen(child.exitCode),
          Effect.map(Number),
          Effect.catch(() => Effect.succeed(null)),
        );
      }
      yield* Effect.all([Fiber.await(stdoutFiber), Fiber.await(stderrFiber)], {
        concurrency: "unbounded",
      });
      return {
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationSeconds: (performance.now() - startedAt) / 1_000,
        termination,
      };
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

    return Effect.runPromise(program).finally(() => {
      requestRunningTermination = undefined;
      processes.delete(owned);
      if (processes.size === 0) this.#runs.delete(runId);
      settleOwned();
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
