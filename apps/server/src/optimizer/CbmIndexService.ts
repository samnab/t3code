import type { CbmProjectIndexStatus, ProjectId, ServerSettingsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsService from "../serverSettings.ts";

const INDEX_TIMEOUT = "30 minutes";
const COMMAND_OUTPUT_LIMIT = 1024 * 1024;

const CbmIndexResult = Schema.Struct({
  status: Schema.String,
  hint: Schema.optionalKey(Schema.String),
});

const CbmProject = Schema.Struct({
  name: Schema.String,
  root_path: Schema.String,
  nodes: Schema.Number,
  edges: Schema.Number,
  size_bytes: Schema.Number,
});

const CbmProjectList = Schema.Struct({
  projects: Schema.Array(CbmProject),
});

const decodeIndexResult = Schema.decodeUnknownOption(Schema.fromJsonString(CbmIndexResult));
const decodeProjectList = Schema.decodeUnknownOption(Schema.fromJsonString(CbmProjectList));

interface CbmIndexJob {
  readonly binaryPath: string | null;
  readonly status: CbmProjectIndexStatus;
  readonly completion: Deferred.Deferred<CbmProjectIndexStatus> | null;
}

export interface CbmIndexServiceDependencies {
  readonly run: (
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly getCbmBinaryPath: Effect.Effect<string, ServerSettingsError>;
  readonly resolvePath: (path: string) => string;
  readonly now: Effect.Effect<string>;
}

export class CbmIndexService extends Context.Service<
  CbmIndexService,
  {
    /**
     * Index a project/root for the configured binary and share in-flight work
     * with concurrent callers. A degraded result retries on the next call.
     */
    readonly ensureIndexed: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
    }) => Effect.Effect<CbmProjectIndexStatus>;
    readonly listStatuses: Effect.Effect<ReadonlyArray<CbmProjectIndexStatus>>;
  }
>()("t3/optimizer/CbmIndexService") {}

const normalizedPath = (path: string): string => {
  const slashNormalized = path.replaceAll("\\", "/");
  const normalized =
    slashNormalized === "/" || /^[a-z]:\/$/i.test(slashNormalized)
      ? slashNormalized
      : slashNormalized.replace(/\/+$/, "");
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith("//")) {
    return normalized.toLowerCase();
  }
  return normalized;
};

const nonNegativeInteger = (value: number): number | undefined =>
  Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const resultDetail = (result: ProcessRunner.ProcessRunOutput): string | undefined => {
  for (const raw of [result.stderr, result.stdout]) {
    const value = raw.trim();
    if (value.length > 0) return value.slice(0, 2_000);
  }
  return undefined;
};

const isProcessTimeoutError = Schema.is(ProcessRunner.ProcessTimeoutError);

const failedCommandDetail = (error: ProcessRunner.ProcessRunError): string => {
  if (isProcessTimeoutError(error)) {
    return "CBM indexing timed out.";
  }
  return "CBM indexing could not be completed.";
};

export const makeWith = Effect.fn("CbmIndexService.makeWith")(function* (
  dependencies: CbmIndexServiceDependencies,
) {
  const jobsRef = yield* Ref.make<ReadonlyMap<string, CbmIndexJob>>(new Map());
  const jobsLock = yield* Semaphore.make(1);

  const statusKey = (projectId: ProjectId, repoPath: string) =>
    `${projectId}\u0000${normalizedPath(repoPath)}`;

  const finish = Effect.fn("CbmIndexService.finish")(function* (
    key: string,
    binaryPath: string | null,
    completion: Deferred.Deferred<CbmProjectIndexStatus>,
    status: CbmProjectIndexStatus,
  ) {
    yield* jobsLock.withPermit(
      Ref.update(jobsRef, (jobs) => {
        if (jobs.get(key)?.completion !== completion) return jobs;
        const next = new Map(jobs);
        next.set(key, { binaryPath, status, completion: null });
        return next;
      }),
    );
    yield* Deferred.succeed(completion, status).pipe(Effect.orDie);
    return status;
  });

  const runIndex = Effect.fn("CbmIndexService.runIndex")(function* (input: {
    readonly projectId: ProjectId;
    readonly repoPath: string;
    readonly binaryPath: string;
  }) {
    const degraded = (detail: string): Effect.Effect<CbmProjectIndexStatus> =>
      dependencies.now.pipe(
        Effect.map((checkedAt) => ({
          projectId: input.projectId,
          repoPath: input.repoPath,
          state: "degraded" as const,
          checkedAt,
          detail,
        })),
      );

    const indexResult = yield* dependencies
      .run({
        command: input.binaryPath,
        args: ["cli", "--quiet", "index_repository", "--repo-path", input.repoPath],
        cwd: input.repoPath,
        env: { CBM_ALLOWED_ROOT: input.repoPath },
        timeout: INDEX_TIMEOUT,
        maxOutputBytes: COMMAND_OUTPUT_LIMIT,
        outputMode: "truncate",
      })
      .pipe(
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      );
    if (indexResult._tag === "Left") {
      return yield* degraded(failedCommandDetail(indexResult.left));
    }
    if (
      indexResult.right.code !== 0 ||
      indexResult.right.timedOut ||
      indexResult.right.stdoutTruncated ||
      indexResult.right.stdoutInvalidUtf8
    ) {
      return yield* degraded(
        resultDetail(indexResult.right) ?? "CBM indexing exited before it was ready.",
      );
    }

    const decodedIndex = decodeIndexResult(indexResult.right.stdout);
    if (Option.isNone(decodedIndex)) {
      return yield* degraded("CBM returned an unrecognized indexing result.");
    }
    if (decodedIndex.value.status !== "indexed" && decodedIndex.value.status !== "degraded") {
      return yield* degraded(
        decodedIndex.value.hint?.trim() ||
          `CBM reported indexing status ${decodedIndex.value.status}.`,
      );
    }

    const projectListResult = yield* dependencies
      .run({
        command: input.binaryPath,
        args: ["cli", "--quiet", "list_projects", "--format", "json", "--detail", "stats"],
        cwd: input.repoPath,
        env: { CBM_ALLOWED_ROOT: input.repoPath },
        timeout: "30 seconds",
        maxOutputBytes: COMMAND_OUTPUT_LIMIT,
        outputMode: "truncate",
      })
      .pipe(
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      );
    if (
      projectListResult._tag === "Left" ||
      projectListResult.right.code !== 0 ||
      projectListResult.right.timedOut ||
      projectListResult.right.stdoutTruncated ||
      projectListResult.right.stdoutInvalidUtf8
    ) {
      return yield* degraded(
        projectListResult._tag === "Right"
          ? (resultDetail(projectListResult.right) ??
              "CBM indexed the repository but did not return project statistics.")
          : "CBM indexed the repository but could not read project statistics.",
      );
    }

    const decodedProjects = decodeProjectList(projectListResult.right.stdout);
    if (Option.isNone(decodedProjects)) {
      return yield* degraded("CBM returned unrecognized project statistics.");
    }
    const expectedRoot = normalizedPath(dependencies.resolvePath(input.repoPath));
    const project = decodedProjects.value.projects.find(
      (entry) => normalizedPath(dependencies.resolvePath(entry.root_path)) === expectedRoot,
    );
    if (project === undefined) {
      return yield* degraded("CBM did not list the indexed repository in its project statistics.");
    }

    const checkedAt = yield* dependencies.now;
    const nodeCount = nonNegativeInteger(project.nodes);
    const edgeCount = nonNegativeInteger(project.edges);
    if (nodeCount === undefined || edgeCount === undefined) {
      return yield* degraded("CBM returned invalid project statistics.");
    }
    const degradedDetail = decodedIndex.value.hint?.trim();
    return {
      projectId: input.projectId,
      repoPath: input.repoPath,
      state: decodedIndex.value.status === "degraded" ? "degraded" : "ready",
      checkedAt,
      nodeCount,
      edgeCount,
      ...(decodedIndex.value.status === "degraded"
        ? { detail: degradedDetail || "CBM indexed the repository with partial coverage." }
        : {}),
    } satisfies CbmProjectIndexStatus;
  });

  const ensureIndexed: CbmIndexService["Service"]["ensureIndexed"] = (input) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const repoPath = dependencies.resolvePath(input.cwd);
        const key = statusKey(input.projectId, repoPath);
        const binaryPathResult = yield* Effect.exit(restore(dependencies.getCbmBinaryPath));
        const binaryPath = binaryPathResult._tag === "Success" ? binaryPathResult.value : null;
        const job = yield* jobsLock.withPermit(
          Effect.gen(function* () {
            const jobs = yield* Ref.get(jobsRef);
            const existing = jobs.get(key);
            if (existing?.completion !== null && existing?.completion !== undefined) {
              return { _tag: "InFlight" as const, completion: existing.completion };
            }
            if (
              existing?.status.state === "ready" &&
              binaryPath !== null &&
              existing.binaryPath === binaryPath
            ) {
              return { _tag: "Ready" as const, status: existing.status };
            }

            const completion = yield* Deferred.make<CbmProjectIndexStatus>();
            const checkedAt = yield* dependencies.now;
            const status = {
              projectId: input.projectId,
              repoPath,
              state: "indexing",
              checkedAt,
            } satisfies CbmProjectIndexStatus;
            const next = new Map(jobs);
            next.set(key, { binaryPath, status, completion });
            yield* Ref.set(jobsRef, next);
            return { _tag: "Started" as const, completion };
          }),
        );
        if (job._tag === "InFlight") return yield* restore(Deferred.await(job.completion));
        if (job._tag === "Ready") return job.status;

        if (binaryPath === null) {
          const checkedAt = yield* dependencies.now;
          return yield* finish(key, binaryPath, job.completion, {
            projectId: input.projectId,
            repoPath,
            state: "degraded",
            checkedAt,
            detail: "CBM indexing did not complete.",
          });
        }

        const exit = yield* Effect.exit(
          restore(runIndex({ projectId: input.projectId, repoPath, binaryPath })),
        );
        if (exit._tag === "Success") {
          return yield* finish(key, binaryPath, job.completion, exit.value);
        }

        const checkedAt = yield* dependencies.now;
        return yield* finish(key, binaryPath, job.completion, {
          projectId: input.projectId,
          repoPath,
          state: "degraded",
          checkedAt,
          detail: "CBM indexing did not complete.",
        });
      }),
    );

  const listStatuses = Ref.get(jobsRef).pipe(
    Effect.map((jobs) =>
      [...jobs.values()]
        .map((job) => job.status)
        .sort(
          (left, right) =>
            left.projectId.localeCompare(right.projectId) ||
            left.repoPath.localeCompare(right.repoPath),
        ),
    ),
  );

  return CbmIndexService.of({ ensureIndexed, listStatuses });
});

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const path = yield* Path.Path;
  return yield* makeWith({
    run: processRunner.run,
    getCbmBinaryPath: settings.getSettings.pipe(
      Effect.map((current) => current.optimizerBinaryPaths.cbm),
    ),
    resolvePath: path.resolve,
    now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
  });
});

export const layer = Layer.effect(CbmIndexService, make);

export const layerTest = () =>
  Layer.succeed(
    CbmIndexService,
    CbmIndexService.of({
      ensureIndexed: ({ projectId, cwd }) =>
        Effect.succeed({
          projectId,
          repoPath: cwd,
          state: "ready",
          checkedAt: "1970-01-01T00:00:00.000Z",
          nodeCount: 0,
          edgeCount: 0,
        }),
      listStatuses: Effect.succeed([]),
    }),
  );
