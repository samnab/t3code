import type {
  CbmProjectIndexStatus,
  OptimizerId,
  OptimizerStatus,
  OptimizerStatusSnapshot,
  ProjectId,
  ProjectOptimizerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CbmIndexService from "./CbmIndexService.ts";
import * as OptimizerProbeService from "./OptimizerProbeService.ts";
import { isSupportedRtkVersion } from "./RtkRewrite.ts";

export const CBM_MCP_SERVER_NAME = "codebase-memory";

export interface SessionRtkAttachment {
  readonly command: "rtk";
}

export interface SessionCbmAttachment {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface SessionHeadroomAttachment {
  readonly environment: Readonly<Record<string, string>>;
  readonly codexAppServerArgs?: ReadonlyArray<string>;
}

export interface SessionOptimizerAttachmentDescriptor {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly configured: ReadonlyArray<OptimizerId>;
  readonly attached: ReadonlyArray<OptimizerId>;
  readonly ready: ReadonlyArray<OptimizerId>;
  readonly rtk?: SessionRtkAttachment;
  readonly headroom?: SessionHeadroomAttachment;
  readonly cbm?: SessionCbmAttachment;
  readonly cbmIndexCompletion?: Effect.Effect<CbmProjectIndexStatus>;
}

export interface SessionOptimizerCapabilities {
  readonly rtk: boolean;
  readonly headroom: boolean;
  readonly cbm: boolean;
}

export function configuredOptimizerIds(
  settings: ProjectOptimizerSettings,
): ReadonlyArray<OptimizerId> {
  return [
    ...(settings.rtk ? (["rtk"] satisfies OptimizerId[]) : []),
    ...(settings.headroom ? (["headroom"] satisfies OptimizerId[]) : []),
    ...(settings.cbm ? (["cbm"] satisfies OptimizerId[]) : []),
  ];
}

export function resolveInstallableSessionOptimizers(input: {
  readonly settings: ProjectOptimizerSettings;
  readonly capabilities: SessionOptimizerCapabilities;
  readonly statuses: ReadonlyArray<OptimizerStatus>;
}): {
  readonly configured: ReadonlyArray<OptimizerId>;
  readonly rtk: boolean;
  readonly headroom: boolean;
  readonly cbm: boolean;
} {
  const rtk = input.statuses.find((status) => status.id === "rtk");
  const headroom = input.statuses.find((status) => status.id === "headroom");
  const cbm = input.statuses.find((status) => status.id === "cbm");
  return {
    configured: configuredOptimizerIds(input.settings),
    rtk:
      input.settings.rtk &&
      input.capabilities.rtk &&
      rtk?.installed === true &&
      isSupportedRtkVersion(rtk.version),
    headroom:
      input.settings.headroom &&
      input.capabilities.headroom &&
      headroom?.installed === true &&
      headroom.running === true,
    cbm: input.settings.cbm && input.capabilities.cbm && cbm?.installed === true,
  };
}

export class SessionOptimizerAttachments extends Context.Service<
  SessionOptimizerAttachments,
  {
    readonly resolve: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string | null;
      readonly capabilities: SessionOptimizerCapabilities;
      readonly resolveHeadroom?: (
        proxyUrl: string,
      ) => Effect.Effect<SessionHeadroomAttachment | undefined>;
    }) => Effect.Effect<SessionOptimizerAttachmentDescriptor | undefined, never, Scope.Scope>;
    readonly getStatus: (input: {
      readonly refresh?: boolean;
    }) => Effect.Effect<OptimizerStatusSnapshot>;
  }
>()("t3/optimizer/SessionOptimizerAttachments") {}

const attachmentsByThread = new Map<ThreadId, SessionOptimizerAttachmentDescriptor>();

export function setSessionOptimizerAttachments(
  threadId: ThreadId,
  descriptor: SessionOptimizerAttachmentDescriptor,
): void {
  attachmentsByThread.set(threadId, descriptor);
}

export function readSessionOptimizerAttachments(
  threadId: ThreadId,
): SessionOptimizerAttachmentDescriptor | undefined {
  return attachmentsByThread.get(threadId);
}

export function clearSessionOptimizerAttachments(threadId: ThreadId): void {
  attachmentsByThread.delete(threadId);
}

export function clearAllSessionOptimizerAttachments(): void {
  attachmentsByThread.clear();
}

export function isCurrentSessionOptimizerAttachments(
  threadId: ThreadId,
  descriptor: SessionOptimizerAttachmentDescriptor,
): boolean {
  return attachmentsByThread.get(threadId) === descriptor;
}

export function removeSessionOptimizerAttachment(threadId: ThreadId, optimizer: OptimizerId): void {
  const current = attachmentsByThread.get(threadId);
  if (current === undefined) return;
  const attached = current.attached.filter((id) => id !== optimizer);
  const ready = current.ready.filter((id) => id !== optimizer);
  if (optimizer === "rtk") {
    const { rtk: removed, ...remaining } = current;
    void removed;
    attachmentsByThread.set(threadId, { ...remaining, attached, ready });
    return;
  }
  if (optimizer === "cbm") {
    const { cbm: removed, cbmIndexCompletion: removedIndex, ...remaining } = current;
    void removed;
    void removedIndex;
    attachmentsByThread.set(threadId, { ...remaining, attached, ready });
    return;
  }
  if (optimizer === "headroom") {
    const { headroom: removed, ...remaining } = current;
    void removed;
    attachmentsByThread.set(threadId, { ...remaining, attached, ready });
    return;
  }
  attachmentsByThread.set(threadId, { ...current, attached, ready });
}

export function buildCodexCbmAppServerArgs(
  attachment: SessionCbmAttachment,
): ReadonlyArray<string> {
  const prefix = `mcp_servers.${CBM_MCP_SERVER_NAME}`;
  return [
    "-c",
    `${prefix}.command=${JSON.stringify(attachment.command)}`,
    "-c",
    `${prefix}.args=${JSON.stringify(attachment.args)}`,
    ...Object.entries(attachment.env).flatMap(([name, value]) => [
      "-c",
      `${prefix}.env.${name}=${JSON.stringify(value)}`,
    ]),
  ];
}

const make = Effect.gen(function* () {
  const cbmIndexes = yield* CbmIndexService.CbmIndexService;
  const optimizerProbe = yield* OptimizerProbeService.OptimizerProbeService;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const resolve: SessionOptimizerAttachments["Service"]["resolve"] = (input) =>
    Effect.gen(function* () {
      clearSessionOptimizerAttachments(input.threadId);
      if (input.cwd === null) return undefined;

      const thread = yield* projectionStore.getThread(input.threadId);
      const settings = yield* serverSettings.getSettings;
      const configuredSettings = settings.projectOptimizerOverrides[thread.projectId] ?? {
        rtk: false,
        headroom: false,
        cbm: false,
      };
      const configured = configuredOptimizerIds(configuredSettings);
      const snapshot =
        configured.length === 0 ? undefined : yield* optimizerProbe.getStatus({ refresh: true });
      const installable = resolveInstallableSessionOptimizers({
        settings: configuredSettings,
        capabilities: input.capabilities,
        statuses: snapshot?.optimizers ?? [],
      });
      const rtkAttached = installable.rtk;
      const headroom =
        installable.headroom && input.resolveHeadroom !== undefined
          ? yield* input.resolveHeadroom(settings.headroomProxyUrl)
          : undefined;
      const cbmAttached = installable.cbm;
      const cbmCompletion = cbmAttached ? yield* Deferred.make<CbmProjectIndexStatus>() : undefined;
      const cbmAttachment =
        cbmCompletion === undefined
          ? {}
          : {
              cbm: {
                command: settings.optimizerBinaryPaths.cbm,
                args: [],
                env: { CBM_ALLOWED_ROOT: input.cwd },
              },
              cbmIndexCompletion: Deferred.await(cbmCompletion),
            };
      const descriptor: SessionOptimizerAttachmentDescriptor = {
        projectId: thread.projectId,
        cwd: input.cwd,
        configured,
        attached: [
          ...(rtkAttached ? (["rtk"] satisfies OptimizerId[]) : []),
          ...(headroom === undefined ? [] : (["headroom"] satisfies OptimizerId[])),
          ...(cbmAttached ? (["cbm"] satisfies OptimizerId[]) : []),
        ],
        ready: [
          ...(rtkAttached ? (["rtk"] satisfies OptimizerId[]) : []),
          ...(headroom === undefined ? [] : (["headroom"] satisfies OptimizerId[])),
        ],
        ...(rtkAttached ? { rtk: { command: "rtk" } } : {}),
        ...(headroom === undefined ? {} : { headroom }),
        ...cbmAttachment,
      };
      setSessionOptimizerAttachments(input.threadId, descriptor);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (isCurrentSessionOptimizerAttachments(input.threadId, descriptor)) {
            clearSessionOptimizerAttachments(input.threadId);
          }
        }),
      );
      if (cbmCompletion !== undefined) {
        yield* cbmIndexes.ensureIndexed({ projectId: thread.projectId, cwd: input.cwd }).pipe(
          Effect.flatMap((status) => Deferred.succeed(cbmCompletion, status)),
          Effect.orDie,
          Effect.forkDetach,
        );
      }
      return descriptor;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not resolve optimizer attachments for provider session.", {
          threadId: input.threadId,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );

  const getStatus: SessionOptimizerAttachments["Service"]["getStatus"] = (input) =>
    optimizerProbe.getStatus(input).pipe(
      Effect.map((snapshot) => ({
        ...snapshot,
        attachments: [...attachmentsByThread.entries()].map(([threadId, descriptor]) => {
          const cbmReady = snapshot.cbmIndexes.some(
            (index) =>
              index.projectId === descriptor.projectId &&
              index.repoPath === descriptor.cwd &&
              index.state === "ready",
          );
          return {
            threadId,
            projectId: descriptor.projectId,
            configured: descriptor.configured,
            attached: descriptor.attached,
            ready:
              cbmReady && descriptor.attached.includes("cbm")
                ? Array.from(new Set([...descriptor.ready, "cbm"] satisfies OptimizerId[]))
                : descriptor.ready,
          };
        }),
      })),
    );

  return SessionOptimizerAttachments.of({ resolve, getStatus });
});

export const layer = Layer.effect(SessionOptimizerAttachments, make);
