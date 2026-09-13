import type { CbmProjectIndexStatus, OptimizerId, ProjectId, ThreadId } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

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
