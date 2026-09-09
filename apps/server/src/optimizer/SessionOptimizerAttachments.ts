import type { OptimizerId, ProjectId, ThreadId } from "@t3tools/contracts";

export const CBM_MCP_SERVER_NAME = "codebase-memory";

export interface SessionRtkAttachment {
  readonly command: "rtk";
}

export interface SessionCbmAttachment {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface SessionOptimizerAttachmentDescriptor {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly configured: ReadonlyArray<OptimizerId>;
  readonly attached: ReadonlyArray<OptimizerId>;
  readonly ready: ReadonlyArray<OptimizerId>;
  readonly rtk?: SessionRtkAttachment;
  readonly cbm?: SessionCbmAttachment;
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
