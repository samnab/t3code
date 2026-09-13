import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ProcessRunInput, ProcessRunOutput } from "../processRunner.ts";
import { makeWith } from "./CbmIndexService.ts";

const success = (stdout: string): ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const failure = (stderr: string): ProcessRunOutput => ({
  ...success(""),
  stderr,
  code: ChildProcessSpawner.ExitCode(1),
});

describe("CbmIndexService", () => {
  it.effect("publishes indexing immediately and coalesces one-shot index work", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const indexStarted = yield* Deferred.make<void>();
      const releaseIndex = yield* Deferred.make<void>();
      const inputs = yield* Ref.make<ReadonlyArray<ProcessRunInput>>([]);
      let time = 0;
      const service = yield* makeWith({
        run: (input) =>
          Ref.update(inputs, (current) => [...current, input]).pipe(
            Effect.andThen(
              input.args.includes("index_repository")
                ? Deferred.succeed(indexStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseIndex)),
                    Effect.as(success('{"project":"repo","status":"indexed"}')),
                  )
                : Effect.succeed(
                    success(
                      '{"projects":[{"name":"repo","root_path":"/repo","nodes":12,"edges":34,"size_bytes":56}],"total":1,"offset":0,"limit":50,"returned":1,"has_more":false}',
                    ),
                  ),
            ),
          ),
        getCbmBinaryPath: Effect.succeed("/tools/cbm"),
        resolvePath: (path) => path,
        now: Effect.sync(() => `2026-01-01T00:00:0${time++}.000Z`),
      });

      const first = yield* service
        .ensureIndexed({ projectId, cwd: "/repo" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(indexStarted);
      expect(yield* service.listStatuses).toEqual([
        {
          projectId,
          repoPath: "/repo",
          state: "indexing",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);

      const second = yield* service
        .ensureIndexed({ projectId, cwd: "/repo" })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseIndex, undefined);
      expect(yield* Fiber.join(first)).toMatchObject({
        state: "ready",
        nodeCount: 12,
        edgeCount: 34,
      });
      expect(yield* Fiber.join(second)).toMatchObject({
        state: "ready",
        nodeCount: 12,
        edgeCount: 34,
      });

      const commands = yield* Ref.get(inputs);
      expect(commands.map((input) => input.args)).toEqual([
        ["cli", "index_repository", "--repo-path", "/repo"],
        ["cli", "list_projects", "--include-details", "true"],
      ]);
      expect(commands[0]?.env).toEqual({ CBM_ALLOWED_ROOT: "/repo" });
    }),
  );

  it.effect("keeps upstream degraded status and graph counts", () =>
    Effect.gen(function* () {
      const service = yield* makeWith({
        run: (input) =>
          Effect.succeed(
            input.args.includes("index_repository")
              ? success('{"project":"repo","status":"degraded","hint":"Some files were skipped."}')
              : success(
                  '{"projects":[{"name":"repo","root_path":"/repo","nodes":8,"edges":13,"size_bytes":21}]}',
                ),
          ),
        getCbmBinaryPath: Effect.succeed("codebase-memory-mcp"),
        resolvePath: (path) => path,
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
      });

      expect(
        yield* service.ensureIndexed({ projectId: ProjectId.make("project-1"), cwd: "/repo" }),
      ).toMatchObject({
        state: "degraded",
        nodeCount: 8,
        edgeCount: 13,
        detail: "Some files were skipped.",
      });
    }),
  );

  it.effect("retries degraded work and reindexes when the configured binary changes", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const indexCommands = yield* Ref.make<ReadonlyArray<string>>([]);
      let binaryPath = "/tools/cbm-a";
      const service = yield* makeWith({
        run: (input) =>
          input.args.includes("index_repository")
            ? Ref.updateAndGet(indexCommands, (commands) => [...commands, input.command]).pipe(
                Effect.map((commands) =>
                  commands.length === 1
                    ? failure("temporary index failure")
                    : success('{"project":"repo","status":"indexed"}'),
                ),
              )
            : Effect.succeed(
                success(
                  '{"projects":[{"name":"repo","root_path":"/repo","nodes":12,"edges":34,"size_bytes":56}]}',
                ),
              ),
        getCbmBinaryPath: Effect.sync(() => binaryPath),
        resolvePath: (path) => path,
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
      });

      expect(yield* service.ensureIndexed({ projectId, cwd: "/repo" })).toMatchObject({
        state: "degraded",
        detail: "temporary index failure",
      });
      expect(yield* service.ensureIndexed({ projectId, cwd: "/repo" })).toMatchObject({
        state: "ready",
      });
      yield* service.ensureIndexed({ projectId, cwd: "/repo" });
      expect(yield* Ref.get(indexCommands)).toEqual(["/tools/cbm-a", "/tools/cbm-a"]);

      binaryPath = "/tools/cbm-b";
      expect(yield* service.ensureIndexed({ projectId, cwd: "/repo" })).toMatchObject({
        state: "ready",
      });
      expect(yield* Ref.get(indexCommands)).toEqual([
        "/tools/cbm-a",
        "/tools/cbm-a",
        "/tools/cbm-b",
      ]);
    }),
  );
});
