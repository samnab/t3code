import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type { QueuedThreadCreation, QueuedThreadMessage } from "../state/thread-outbox-model";
import { toUploadChatImageAttachments, type DraftComposerImageAttachment } from "./composerImages";

export function deriveThreadTitleFromPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "New thread";
  }

  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  /** Generated temp branch for worktree mode; unused for local mode. */
  readonly worktreeBranchName: string;
}

/**
 * Single source of the `thread.turn.start` bootstrap payload used to create a
 * thread from a project draft — shared by the immediate send path and the
 * offline outbox drain so both deliver identical commands.
 */
export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleFromPrompt(spec.text);
  const isWorktree = spec.workspaceMode === "worktree";
  return {
    commandId: CommandId.make(spec.commandId),
    threadId: ThreadId.make(spec.threadId),
    message: {
      messageId: MessageId.make(spec.messageId),
      role: "user" as const,
      text: spec.text,
      attachments: toUploadChatImageAttachments(spec.attachments),
    },
    modelSelection: spec.modelSelection,
    titleSeed: title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: isWorktree ? null : spec.worktreePath,
        createdAt: spec.createdAt,
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              baseBranch: spec.branch!,
              branch: spec.worktreeBranchName,
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: spec.createdAt,
  };
}

/**
 * The exact `thread.turn.start` payload the outbox drain sends for a queued
 * creation. The drain's delivery action classifies the queued text raw, so
 * the wire payload carries that same text unchanged — a native trim here
 * would strip a leading U+FEFF and deliver "/goal …" that the server decider
 * treats as a goal command instead of a turn. Null when the row never
 * carried a model selection.
 */
export function buildQueuedCreationStartTurnInput(input: {
  readonly message: QueuedThreadMessage;
  readonly creation: QueuedThreadCreation;
  readonly projectCwd: string;
  /** Generated per delivery by the caller; unused for local mode. */
  readonly worktreeBranchName: string;
}) {
  const { message, creation, projectCwd, worktreeBranchName } = input;
  if (message.modelSelection === undefined) {
    return null;
  }
  return buildProjectThreadStartTurnInput({
    projectId: creation.projectId,
    projectCwd,
    threadId: message.threadId,
    commandId: message.commandId,
    messageId: message.messageId,
    createdAt: message.createdAt,
    text: message.text,
    attachments: message.attachments,
    modelSelection: message.modelSelection,
    runtimeMode: message.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: message.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    workspaceMode: creation.workspaceMode,
    branch: creation.branch,
    worktreePath: creation.worktreePath,
    startFromOrigin: creation.startFromOrigin ?? false,
    worktreeBranchName,
  });
}
