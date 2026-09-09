import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { ProcessRunInput, ProcessRunOutput } from "../processRunner.ts";
import { makeWith, parseHeadroomSavings } from "./OptimizerProbeService.ts";

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

describe("OptimizerProbeService", () => {
  it.effect("discovers fixed optimizer rows and normalizes host-wide savings", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<ProcessRunInput>>([]);
      const service = yield* makeWith({
        run: (input) =>
          Ref.update(commands, (current) => [...current, input]).pipe(
            Effect.as(
              success(
                input.args[0] === "gain"
                  ? '{"summary":{"total_commands":2,"total_input":100,"total_output":20,"total_saved":80}}'
                  : input.command === "rtk"
                    ? "rtk 0.24.1"
                    : input.command === "/tools/cbm"
                      ? "codebase-memory-mcp 1.2.3"
                      : "headroom 0.9.0",
              ),
            ),
          ),
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: Effect.succeed({ savings: { total_tokens: 321 } }),
        getCbmBinaryPath: Effect.succeed("/tools/cbm"),
        listCbmIndexes: Effect.succeed([
          {
            projectId: ProjectId.make("project-1"),
            repoPath: "/repo",
            state: "ready",
            checkedAt: "2026-01-01T00:00:00.000Z",
            nodeCount: 12,
            edgeCount: 34,
          },
        ]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
      });

      const snapshot = yield* service.getStatus({});
      expect(snapshot.optimizers).toEqual([
        {
          id: "rtk",
          installed: true,
          version: "0.24.1",
          mode: "cli-wrapper",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "headroom",
          installed: true,
          version: "0.9.0",
          running: true,
          mode: "detected-proxy",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "cbm",
          installed: true,
          version: "1.2.3",
          mode: "stdio-mcp",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(snapshot.savings).toEqual([
        { source: "rtk", scope: "environment", window: "all-time", tokensSaved: 80 },
        { source: "headroom", scope: "environment", window: "session", tokensSaved: 321 },
      ]);
      expect(snapshot.cbmIndexes[0]).toMatchObject({ state: "ready", nodeCount: 12 });
      expect((yield* Ref.get(commands)).some((input) => input.command === "/tools/cbm")).toBe(true);
    }),
  );

  it.effect("caches default reads and coalesces concurrent refreshes", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const headroomCalls = yield* Ref.make(0);
      const refreshStarted = yield* Deferred.make<void>();
      const releaseRefresh = yield* Deferred.make<void>();
      const service = yield* makeWith({
        run: (input) =>
          Ref.updateAndGet(calls, (current) => current + 1).pipe(
            Effect.as(
              success(input.args[0] === "gain" ? '{"summary":{"total_saved":1}}' : "tool 1.2.3"),
            ),
          ),
        isMissingResult: () => Effect.succeed(false),
        fetchHeadroomStats: Ref.updateAndGet(headroomCalls, (current) => current + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 1
              ? Effect.succeed({ display_session: { tokens_saved: 1 } })
              : Deferred.succeed(refreshStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRefresh)),
                  Effect.as({ display_session: { tokens_saved: 1 } }),
                ),
          ),
        ),
        getCbmBinaryPath: Effect.succeed("cbm"),
        listCbmIndexes: Effect.succeed([]),
        now: Effect.succeed("2026-01-01T00:00:00.000Z"),
      });

      yield* service.getStatus({});
      const afterFirst = yield* Ref.get(calls);
      yield* service.getStatus({});
      expect(yield* Ref.get(calls)).toBe(afterFirst);
      const firstRefresh = yield* service.getStatus({ refresh: true }).pipe(Effect.forkChild);
      yield* Deferred.await(refreshStarted);
      const secondRefresh = yield* service.getStatus({ refresh: true }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(firstRefresh);
      yield* Fiber.join(secondRefresh);
      expect(yield* Ref.get(calls)).toBe(afterFirst * 2);
    }),
  );

  it("tolerates partial and malformed Headroom counters", () => {
    expect(parseHeadroomSavings({ tokens: { saved: 5 } })).toBe(5);
    expect(parseHeadroomSavings({ display_session: { tokens_saved: 8 } })).toBe(8);
    expect(parseHeadroomSavings({ savings: { total_tokens: -1 } })).toBeNull();
    expect(parseHeadroomSavings({ savings: { total_tokens: "100" } })).toBeNull();
    expect(parseHeadroomSavings("not-an-object")).toBeNull();
  });
});
