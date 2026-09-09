import {
  DEFAULT_CBM_BINARY_PATH,
  type CbmProjectIndexStatus,
  type OptimizerSavingsSummary,
  type OptimizerStatus,
  type OptimizerStatusSnapshot,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CbmIndexService } from "./CbmIndexService.ts";

const PROBE_TIMEOUT = Duration.seconds(4);
const HEADROOM_STATS_URL = "http://127.0.0.1:6767/stats?cached=1";

const RtkGain = Schema.Struct({
  summary: Schema.Struct({
    total_saved: Schema.Number,
  }),
});

const HeadroomStats = Schema.Struct({
  savings: Schema.optionalKey(Schema.Unknown),
  tokens: Schema.optionalKey(Schema.Unknown),
  display_session: Schema.optionalKey(Schema.Unknown),
});

const HeadroomSavings = Schema.Struct({ total_tokens: Schema.optionalKey(Schema.Unknown) });
const HeadroomTokens = Schema.Struct({ saved: Schema.optionalKey(Schema.Unknown) });
const HeadroomDisplaySession = Schema.Struct({ tokens_saved: Schema.optionalKey(Schema.Unknown) });

const decodeRtkGain = Schema.decodeUnknownOption(Schema.fromJsonString(RtkGain));
const decodeHeadroomStats = Schema.decodeUnknownOption(HeadroomStats);
const decodeHeadroomSavings = Schema.decodeUnknownOption(HeadroomSavings);
const decodeHeadroomTokens = Schema.decodeUnknownOption(HeadroomTokens);
const decodeHeadroomDisplaySession = Schema.decodeUnknownOption(HeadroomDisplaySession);

interface OptimizerDiscoverySnapshot {
  readonly optimizers: ReadonlyArray<OptimizerStatus>;
  readonly savings: ReadonlyArray<OptimizerSavingsSummary>;
}

export interface OptimizerProbeDependencies {
  readonly run: (
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly isMissingResult: (result: ProcessRunner.ProcessRunOutput) => Effect.Effect<boolean>;
  readonly fetchHeadroomStats: Effect.Effect<unknown, HeadroomStatsProbeError>;
  readonly getCbmBinaryPath: Effect.Effect<string, ServerSettingsError>;
  readonly listCbmIndexes: Effect.Effect<ReadonlyArray<CbmProjectIndexStatus>>;
  readonly now: Effect.Effect<string>;
}

class HeadroomStatsProbeError extends Schema.TaggedErrorClass<HeadroomStatsProbeError>()(
  "HeadroomStatsProbeError",
  {},
) {}

export class OptimizerProbeService extends Context.Service<
  OptimizerProbeService,
  {
    /** Omitted refresh serves the shared cache; refresh coalesces concurrent probes. */
    readonly getStatus: (input: {
      readonly refresh?: boolean | undefined;
    }) => Effect.Effect<OptimizerStatusSnapshot>;
  }
>()("t3/optimizer/OptimizerProbeService") {}

const safeTokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseRtkSavings(stdout: string): number | null {
  const decoded = decodeRtkGain(stdout);
  return Option.isSome(decoded) ? safeTokenCount(decoded.value.summary.total_saved) : null;
}

export function parseHeadroomSavings(input: unknown): number | null {
  const stats = decodeHeadroomStats(input);
  if (Option.isNone(stats)) return null;

  const savings = decodeHeadroomSavings(stats.value.savings);
  if (Option.isSome(savings)) {
    const count = safeTokenCount(savings.value.total_tokens);
    if (count !== null) return count;
  }
  const tokens = decodeHeadroomTokens(stats.value.tokens);
  if (Option.isSome(tokens)) {
    const count = safeTokenCount(tokens.value.saved);
    if (count !== null) return count;
  }
  const displaySession = decodeHeadroomDisplaySession(stats.value.display_session);
  return Option.isSome(displaySession) ? safeTokenCount(displaySession.value.tokens_saved) : null;
}

const versionFromOutput = (output: string): string | null =>
  output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1] ?? null;

const failureDetail = (error: ProcessRunner.ProcessRunError): string => {
  if (error._tag === "ProcessTimeoutError") return "Version probe timed out.";
  return "Version probe failed.";
};

const isMissingRunError = (error: ProcessRunner.ProcessRunError): boolean =>
  error._tag === "ProcessSpawnError" &&
  error.cause instanceof PlatformError.PlatformError &&
  error.cause.reason._tag === "NotFound";

interface VersionProbe {
  readonly installed: boolean;
  readonly version: string | null;
  readonly detail?: string;
}

export const makeWith = Effect.fn("OptimizerProbeService.makeWith")(function* (
  dependencies: OptimizerProbeDependencies,
) {
  const cache = yield* Ref.make<{
    readonly revision: number;
    readonly snapshot: OptimizerDiscoverySnapshot | null;
  }>({ revision: 0, snapshot: null });
  const refreshLock = yield* Semaphore.make(1);

  const versionProbe = Effect.fn("OptimizerProbeService.versionProbe")(function* (
    command: string,
  ): Effect.fn.Return<VersionProbe> {
    const attempt = yield* dependencies
      .run({
        command,
        args: ["--version"],
        timeout: PROBE_TIMEOUT,
        maxOutputBytes: 32 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.match({
          onFailure: (left) => ({ _tag: "Left" as const, left }),
          onSuccess: (right) => ({ _tag: "Right" as const, right }),
        }),
      );
    if (attempt._tag === "Left") {
      return isMissingRunError(attempt.left)
        ? { installed: false, version: null, detail: "Command was not found." }
        : { installed: true, version: null, detail: failureDetail(attempt.left) };
    }
    if (yield* dependencies.isMissingResult(attempt.right)) {
      return { installed: false, version: null, detail: "Command was not found." };
    }
    const version = versionFromOutput(`${attempt.right.stdout}\n${attempt.right.stderr}`);
    return {
      installed: true,
      version,
      ...(attempt.right.code === 0
        ? version === null
          ? { detail: "The installed version could not be parsed." }
          : {}
        : { detail: `Version probe exited with code ${String(attempt.right.code)}.` }),
    };
  });

  const discover = Effect.fn("OptimizerProbeService.discover")(function* () {
    const cbmBinaryPath = yield* dependencies.getCbmBinaryPath.pipe(
      Effect.catchCause(() => Effect.succeed(DEFAULT_CBM_BINARY_PATH)),
    );
    const [rtk, cbm, headroomCli, headroomStatsResult] = yield* Effect.all(
      [
        versionProbe("rtk"),
        versionProbe(cbmBinaryPath),
        versionProbe("headroom"),
        dependencies.fetchHeadroomStats.pipe(
          Effect.match({
            onFailure: (left) => ({ _tag: "Left" as const, left }),
            onSuccess: (right) => ({ _tag: "Right" as const, right }),
          }),
        ),
      ],
      { concurrency: "unbounded" },
    );
    const checkedAt = yield* dependencies.now;

    const headroomStats =
      headroomStatsResult._tag === "Right"
        ? decodeHeadroomStats(headroomStatsResult.right)
        : Option.none();
    const headroomRunning = Option.isSome(headroomStats);
    const headroomSavings = Option.isSome(headroomStats)
      ? parseHeadroomSavings(headroomStats.value)
      : null;

    const rtkSavings = rtk.installed
      ? yield* dependencies
          .run({
            command: "rtk",
            args: ["gain", "--all", "--format", "json"],
            timeout: PROBE_TIMEOUT,
            maxOutputBytes: 256 * 1024,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((result) => (result.code === 0 ? parseRtkSavings(result.stdout) : null)),
            Effect.catchCause(() => Effect.succeed(null)),
          )
      : null;

    const optimizers: OptimizerStatus[] = [
      {
        id: "rtk",
        installed: rtk.installed,
        version: rtk.version,
        mode: "cli-wrapper",
        checkedAt,
        ...(rtk.detail === undefined ? {} : { detail: rtk.detail }),
      },
      {
        id: "headroom",
        installed: headroomRunning || headroomCli.installed,
        version: headroomCli.version,
        running: headroomRunning,
        mode: "detected-proxy",
        checkedAt,
        ...(!headroomRunning && headroomCli.installed
          ? { detail: "Headroom is installed, but its local proxy is not responding." }
          : !headroomRunning && headroomCli.detail !== undefined
            ? { detail: headroomCli.detail }
            : {}),
      },
      {
        id: "cbm",
        installed: cbm.installed,
        version: cbm.version,
        mode: "stdio-mcp",
        checkedAt,
        ...(cbm.detail === undefined ? {} : { detail: cbm.detail }),
      },
    ];
    const savings: OptimizerSavingsSummary[] = [
      ...(rtkSavings === null
        ? []
        : [
            {
              source: "rtk" as const,
              scope: "environment" as const,
              window: "all-time" as const,
              tokensSaved: rtkSavings,
            },
          ]),
      ...(headroomSavings === null
        ? []
        : [
            {
              source: "headroom" as const,
              scope: "environment" as const,
              window: "session" as const,
              tokensSaved: headroomSavings,
            },
          ]),
    ];
    return { optimizers, savings } satisfies OptimizerDiscoverySnapshot;
  });

  const getStatus: OptimizerProbeService["Service"]["getStatus"] = (input) =>
    Effect.gen(function* () {
      const observedRevision = (yield* Ref.get(cache)).revision;
      const snapshot = yield* refreshLock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(cache);
          if (
            current.snapshot !== null &&
            (!input.refresh || current.revision !== observedRevision)
          ) {
            return current.snapshot;
          }
          const next = yield* discover();
          yield* Ref.set(cache, { revision: current.revision + 1, snapshot: next });
          return next;
        }),
      );
      const cbmIndexes = yield* dependencies.listCbmIndexes.pipe(
        Effect.catchCause(() => Effect.succeed([])),
      );
      return { ...snapshot, cbmIndexes } satisfies OptimizerStatusSnapshot;
    });

  return OptimizerProbeService.of({ getStatus });
});

export const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const cbmIndexes = yield* CbmIndexService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostPlatform = yield* HostProcessPlatform;

  return yield* makeWith({
    run: processRunner.run,
    isMissingResult: (result) =>
      ProcessRunner.isWindowsCommandNotFound(Number(result.code), result.stderr).pipe(
        Effect.provideService(HostProcessPlatform, hostPlatform),
      ),
    fetchHeadroomStats: httpClient.get(HEADROOM_STATS_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(Duration.seconds(2)),
      Effect.mapError(() => new HeadroomStatsProbeError()),
    ),
    getCbmBinaryPath: settings.getSettings.pipe(
      Effect.map((current) => current.optimizerBinaryPaths.cbm),
    ),
    listCbmIndexes: cbmIndexes.listStatuses,
    now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
  });
});

export const layer = Layer.effect(OptimizerProbeService, make);

const TEST_CHECKED_AT = "1970-01-01T00:00:00.000Z";

export const layerTest = (snapshot?: OptimizerStatusSnapshot) =>
  Layer.succeed(
    OptimizerProbeService,
    OptimizerProbeService.of({
      getStatus: () =>
        Effect.succeed(
          snapshot ?? {
            optimizers: [
              {
                id: "rtk",
                installed: false,
                version: null,
                mode: "cli-wrapper",
                checkedAt: TEST_CHECKED_AT,
              },
              {
                id: "headroom",
                installed: false,
                version: null,
                running: false,
                mode: "detected-proxy",
                checkedAt: TEST_CHECKED_AT,
              },
              {
                id: "cbm",
                installed: false,
                version: null,
                mode: "stdio-mcp",
                checkedAt: TEST_CHECKED_AT,
              },
            ],
            savings: [],
            cbmIndexes: [],
          },
        ),
    }),
  );
