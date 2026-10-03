import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.match(handle.exitCode, {
    onFailure: (cause) =>
      new CodexError.CodexAppServerTransportError({
        operation: "read-process-exit-status",
        pid: handle.pid,
        cause,
      }),
    onSuccess: (code) => new CodexError.CodexAppServerProcessExitedError({ code, pid: handle.pid }),
  });

/** Last few KiB of app-server stderr kept so an exit code carries its reason. */
export const CODEX_STDERR_TAIL_MAX_CHARS = 4_096;

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+=/]+/gi;

export const appendCodexStderrTail = (current: string, chunk: string): string => {
  const next = `${current}${chunk.replaceAll("\0", "").replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")}`;
  return next.length <= CODEX_STDERR_TAIL_MAX_CHARS
    ? next
    : next.slice(-CODEX_STDERR_TAIL_MAX_CHARS);
};

/**
 * Collects the child's stderr into a bounded tail. Pass the returned
 * `terminationError` to `make` so a process exit reports why the app-server
 * died instead of a bare exit code.
 */
export const makeChildStderrTail = Effect.fn("makeChildStderrTail")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
) {
  const tail = yield* Ref.make("");
  const drained = yield* Deferred.make<void>();

  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(tail, (current) => appendCodexStderrTail(current, chunk)),
    ),
    Effect.ensuring(Deferred.succeed(drained, undefined)),
    Effect.ignore,
    Effect.forkScoped,
  );

  return Effect.flatMap(makeTerminationError(handle), (error) =>
    error._tag !== "CodexAppServerProcessExitedError"
      ? Effect.succeed<CodexError.CodexAppServerError>(error)
      : Deferred.await(drained).pipe(
          Effect.timeout("250 millis"),
          Effect.ignore,
          Effect.andThen(Ref.get(tail)),
          Effect.map((text): CodexError.CodexAppServerError => {
            const stderr = text.trim();
            return stderr.length === 0
              ? error
              : new CodexError.CodexAppServerProcessExitedError({
                  ...(error.code === undefined ? {} : { code: error.code }),
                  ...(error.pid === undefined ? {} : { pid: error.pid }),
                  stderr,
                  ...(error.cause === undefined ? {} : { cause: error.cause }),
                });
          }),
        ),
  );
});
