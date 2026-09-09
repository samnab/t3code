import {
  DEFAULT_CBM_BINARY_PATH,
  DEFAULT_HEADROOM_PROXY_URL,
  normalizeHeadroomProxyUrl,
  type CbmProjectIndexStatus,
  type OptimizerSavingsInterval,
  type OptimizerSavingsPoint,
  type OptimizerSavingsSummary,
  type OptimizerStatus,
  type OptimizerStatusSnapshot,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
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
const REFRESH_COOLDOWN_MS = 5_000;

const RtkGain = Schema.Struct({
  summary: Schema.Struct({
    total_saved: Schema.Number,
  }),
});

const HeadroomStats = Schema.Struct({
  display_session: Schema.Unknown,
});

const HeadroomHealth = Schema.Struct({
  service: Schema.Literal("headroom-proxy"),
  status: Schema.Literals(["healthy", "unhealthy"]),
  version: Schema.optionalKey(Schema.String),
});

const HeadroomDisplaySession = Schema.Struct({ tokens_saved: Schema.optionalKey(Schema.Unknown) });
const HeadroomHistoryPoint = Schema.Struct({
  timestamp: Schema.String,
  tokens_saved: Schema.Unknown,
});
const HeadroomHistorySeries = Schema.Struct({
  hourly: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  daily: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  weekly: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  monthly: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
const HeadroomHistory = Schema.Struct({ series: Schema.optionalKey(Schema.Unknown) });

const decodeRtkGain = Schema.decodeUnknownOption(Schema.fromJsonString(RtkGain));
const decodeHeadroomStats = Schema.decodeUnknownOption(HeadroomStats);
const decodeHeadroomHealth = Schema.decodeUnknownOption(HeadroomHealth);
const decodeHeadroomDisplaySession = Schema.decodeUnknownOption(HeadroomDisplaySession);
const decodeHeadroomHistory = Schema.decodeUnknownOption(HeadroomHistory);
const decodeHeadroomHistorySeries = Schema.decodeUnknownOption(HeadroomHistorySeries);
const decodeHeadroomHistoryPoint = Schema.decodeUnknownOption(HeadroomHistoryPoint);

interface OptimizerDiscoverySnapshot {
  readonly optimizers: ReadonlyArray<OptimizerStatus>;
  readonly savings: ReadonlyArray<OptimizerSavingsSummary>;
  readonly savingsHistory: ReadonlyArray<OptimizerSavingsPoint>;
}

export interface OptimizerProbeDependencies {
  readonly run: (
    input: ProcessRunner.ProcessRunInput,
  ) => Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
  readonly isMissingResult: (result: ProcessRunner.ProcessRunOutput) => Effect.Effect<boolean>;
  readonly fetchHeadroomStats: (
    proxyUrl: string,
  ) => Effect.Effect<unknown, HeadroomStatsProbeError>;
  readonly fetchHeadroomHealth: (
    proxyUrl: string,
  ) => Effect.Effect<unknown, HeadroomStatsProbeError>;
  readonly fetchHeadroomHistory: (
    proxyUrl: string,
  ) => Effect.Effect<unknown, HeadroomStatsProbeError>;
  readonly getCbmBinaryPath: Effect.Effect<string, ServerSettingsError>;
  readonly getHeadroomProxyUrl: Effect.Effect<string, ServerSettingsError>;
  readonly listCbmIndexes: Effect.Effect<ReadonlyArray<CbmProjectIndexStatus>>;
  readonly now: Effect.Effect<string>;
  readonly nowMs: Effect.Effect<number>;
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

  const displaySession = decodeHeadroomDisplaySession(stats.value.display_session);
  return Option.isSome(displaySession) ? safeTokenCount(displaySession.value.tokens_saved) : null;
}

export function parseHeadroomSavingsHistory(input: unknown): ReadonlyArray<OptimizerSavingsPoint> {
  const history = decodeHeadroomHistory(input);
  if (Option.isNone(history)) return [];
  const series = decodeHeadroomHistorySeries(history.value.series);
  if (Option.isNone(series)) return [];

  const intervals: ReadonlyArray<
    readonly [OptimizerSavingsInterval, ReadonlyArray<unknown> | undefined]
  > = [
    ["hour", series.value.hourly],
    ["day", series.value.daily],
    ["week", series.value.weekly],
    ["month", series.value.monthly],
  ];
  const points: OptimizerSavingsPoint[] = [];
  for (const [interval, entries] of intervals) {
    for (const entry of entries ?? []) {
      const decoded = decodeHeadroomHistoryPoint(entry);
      if (Option.isNone(decoded)) continue;
      const timestamp = DateTime.make(decoded.value.timestamp);
      const tokensSaved = safeTokenCount(decoded.value.tokens_saved);
      if (Option.isNone(timestamp) || tokensSaved === null) continue;
      points.push({
        source: "headroom",
        scope: "environment",
        interval,
        timestamp: DateTime.formatIso(timestamp.value),
        tokensSaved,
      });
    }
  }
  return points;
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
    readonly cbmBinaryPath: string | null;
    readonly headroomProxyUrl: string | null;
    readonly refreshedAtMs: number | null;
  }>({
    revision: 0,
    snapshot: null,
    cbmBinaryPath: null,
    headroomProxyUrl: null,
    refreshedAtMs: null,
  });
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
      return {
        installed: false,
        version: null,
        detail: isMissingRunError(attempt.left)
          ? "Command was not found."
          : failureDetail(attempt.left),
      };
    }
    if (yield* dependencies.isMissingResult(attempt.right)) {
      return { installed: false, version: null, detail: "Command was not found." };
    }
    const version = versionFromOutput(`${attempt.right.stdout}\n${attempt.right.stderr}`);
    if (attempt.right.timedOut) {
      return { installed: false, version: null, detail: "Version probe timed out." };
    }
    if (attempt.right.code !== 0) {
      return {
        installed: false,
        version,
        detail: `Version probe exited with code ${String(attempt.right.code)}.`,
      };
    }
    if (version === null) {
      return {
        installed: false,
        version: null,
        detail: "The installed version could not be parsed.",
      };
    }
    return { installed: true, version };
  });

  const discover = Effect.fn("OptimizerProbeService.discover")(function* (
    cbmBinaryPath: string,
    headroomProxyUrl: string,
  ) {
    const [
      rtk,
      cbm,
      headroomCli,
      headroomStatsResult,
      headroomHealthResult,
      headroomHistoryResult,
    ] = yield* Effect.all(
      [
        versionProbe("rtk"),
        versionProbe(cbmBinaryPath),
        versionProbe("headroom"),
        dependencies.fetchHeadroomStats(headroomProxyUrl).pipe(
          Effect.match({
            onFailure: (left) => ({ _tag: "Left" as const, left }),
            onSuccess: (right) => ({ _tag: "Right" as const, right }),
          }),
        ),
        dependencies.fetchHeadroomHealth(headroomProxyUrl).pipe(
          Effect.match({
            onFailure: (left) => ({ _tag: "Left" as const, left }),
            onSuccess: (right) => ({ _tag: "Right" as const, right }),
          }),
        ),
        dependencies.fetchHeadroomHistory(headroomProxyUrl).pipe(
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
    const headroomHealth =
      headroomHealthResult._tag === "Right"
        ? decodeHeadroomHealth(headroomHealthResult.right)
        : Option.none();
    const headroomReportedUnhealthy =
      Option.isSome(headroomHealth) && headroomHealth.value.status === "unhealthy";
    const headroomRunning =
      !headroomReportedUnhealthy &&
      (Option.isSome(headroomStats) ||
        (Option.isSome(headroomHealth) && headroomHealth.value.status === "healthy"));
    const headroomSavings =
      headroomRunning && Option.isSome(headroomStats)
        ? parseHeadroomSavings(headroomStats.value)
        : null;
    const savingsHistory =
      headroomRunning && headroomHistoryResult._tag === "Right"
        ? parseHeadroomSavingsHistory(headroomHistoryResult.right)
        : [];

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
        installed:
          headroomCli.installed || Option.isSome(headroomStats) || Option.isSome(headroomHealth),
        version:
          headroomCli.version ??
          (Option.isSome(headroomHealth)
            ? versionFromOutput(headroomHealth.value.version ?? "")
            : null),
        running: headroomRunning,
        mode: "detected-proxy",
        checkedAt,
        ...(headroomReportedUnhealthy
          ? { detail: "The configured Headroom proxy reported an unhealthy status." }
          : !headroomRunning && headroomHealthResult._tag === "Right"
            ? { detail: "The configured endpoint did not identify itself as a Headroom proxy." }
            : !headroomRunning && headroomCli.installed
              ? {
                  detail:
                    "Headroom is installed, but its configured local proxy is not responding.",
                }
              : !headroomRunning && headroomCli.detail !== undefined
                ? { detail: headroomCli.detail }
                : headroomRunning && Option.isNone(headroomStats)
                  ? { detail: "Headroom is running, but savings statistics are unavailable." }
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
    return { optimizers, savings, savingsHistory } satisfies OptimizerDiscoverySnapshot;
  });

  const getStatus: OptimizerProbeService["Service"]["getStatus"] = (input) =>
    Effect.gen(function* () {
      const cbmBinaryPath = yield* dependencies.getCbmBinaryPath.pipe(
        Effect.catchCause(() => Effect.succeed(DEFAULT_CBM_BINARY_PATH)),
      );
      const configuredHeadroomProxyUrl = yield* dependencies.getHeadroomProxyUrl.pipe(
        Effect.catchCause(() => Effect.succeed(DEFAULT_HEADROOM_PROXY_URL)),
      );
      const headroomProxyUrl =
        normalizeHeadroomProxyUrl(configuredHeadroomProxyUrl) ?? DEFAULT_HEADROOM_PROXY_URL;
      const nowMs = yield* dependencies.nowMs;
      const observedRevision = (yield* Ref.get(cache)).revision;
      const snapshot = yield* refreshLock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(cache);
          const sameCbmBinary = current.cbmBinaryPath === cbmBinaryPath;
          const sameHeadroomProxy = current.headroomProxyUrl === headroomProxyUrl;
          const refreshIsCoolingDown =
            current.refreshedAtMs !== null && nowMs - current.refreshedAtMs < REFRESH_COOLDOWN_MS;
          if (
            current.snapshot !== null &&
            sameCbmBinary &&
            sameHeadroomProxy &&
            (!input.refresh || current.revision !== observedRevision || refreshIsCoolingDown)
          ) {
            return current.snapshot;
          }
          const next = yield* discover(cbmBinaryPath, headroomProxyUrl);
          yield* Ref.set(cache, {
            revision: current.revision + 1,
            snapshot: next,
            cbmBinaryPath,
            headroomProxyUrl,
            refreshedAtMs: nowMs,
          });
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
    fetchHeadroomStats: (proxyUrl) =>
      httpClient.get(`${proxyUrl}/stats`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(Duration.seconds(2)),
        Effect.mapError(() => new HeadroomStatsProbeError()),
      ),
    fetchHeadroomHealth: (proxyUrl) =>
      httpClient.get(`${proxyUrl}/health`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(Duration.seconds(2)),
        Effect.mapError(() => new HeadroomStatsProbeError()),
      ),
    fetchHeadroomHistory: (proxyUrl) =>
      httpClient.get(`${proxyUrl}/stats-history`).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout(Duration.seconds(2)),
        Effect.mapError(() => new HeadroomStatsProbeError()),
      ),
    getCbmBinaryPath: settings.getSettings.pipe(
      Effect.map((current) => current.optimizerBinaryPaths.cbm),
    ),
    getHeadroomProxyUrl: settings.getSettings.pipe(
      Effect.map((current) => current.headroomProxyUrl),
    ),
    listCbmIndexes: cbmIndexes.listStatuses,
    now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    nowMs: Clock.currentTimeMillis,
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
            savingsHistory: [],
            cbmIndexes: [],
          },
        ),
    }),
  );
