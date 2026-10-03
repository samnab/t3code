import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";
import { CODEX_STDERR_TAIL_MAX_CHARS, makeChildStderrTail, makeTerminationError } from "./stdio.ts";

const handleWithStderr = (stderr: string, code: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(53),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.encodeText(Stream.make(stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

describe("Codex App Server child process termination", () => {
  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(51),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 51);
      assert.equal(error.code, 9);
      assert.equal(error.message, "Codex App Server process exited with code 9");
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );

  it.effect("reports the stderr tail with a non-zero exit code", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const terminationError = yield* makeChildStderrTail(
          handleWithStderr(
            "Error: failed to initialize sqlite state runtime under /home/u/.codex\n",
            1,
          ),
        );
        const error = yield* terminationError;

        assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
        assert.include(error.message, "Codex App Server process exited with code 1");
        assert.include(error.message, "failed to initialize sqlite state runtime");
      }),
    ),
  );

  it.effect("bounds the stderr tail and redacts bearer tokens", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const terminationError = yield* makeChildStderrTail(
          handleWithStderr(
            `${"n".repeat(CODEX_STDERR_TAIL_MAX_CHARS)}\nAuthorization: Bearer t3-secret-value\n`,
            1,
          ),
        );
        const error = yield* terminationError;

        assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
        assert.isAtMost(error.stderr?.length ?? 0, CODEX_STDERR_TAIL_MAX_CHARS);
        assert.notInclude(error.message, "t3-secret-value");
        assert.include(error.message, "Bearer [redacted]");
      }),
    ),
  );
});
