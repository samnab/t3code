import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  THREAD_GOAL_MAX_CHARS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  hasVisibleThreadGoalText,
  trimThreadGoalWhitespace,
} from "@t3tools/shared/composerTrigger";
import {
  nextThreadGoalEditorEpoch,
  threadExperimentObjectiveError,
  threadGoalEditorCanSave,
  type ThreadGoalLoopAction,
  deleteThreadGoalWork,
  threadGoalEditorReducer,
} from "@t3tools/client-runtime/state/threadGoalEditor";
import {
  createExecutionGoalPanelController,
  executionGoalCanRefresh,
  executionGoalPanelReducer,
  type ExecutionGoalPanelState,
} from "@t3tools/client-runtime/state/executionGoalPanel";
import {
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { composerContextSendBlockReason, reidentifyComposerContext } from "../lib/composerContext";
import { uuidv4 } from "../lib/uuid";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "../features/threads/legacy-plan-mode";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { acknowledgedThreadMessagesAtom } from "./acknowledged-thread-messages";
import { appendPendingThreadMessages } from "../features/threads/pending-thread-feed";
import { appAtomRegistry } from "../state/atom-registry";
import { pendingThreadCreationMessage } from "./pending-thread-creation";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  insertComposerDraftContext,
  clearComposerDraftContent,
  clearComposerDraftContentIfUnchanged,
  composerDraftsAtom,
  composerContextImportsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "../state/use-remote-environment-registry";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import {
  blockedQueuedThreadMessages,
  enqueueThreadOutboxMessage,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import { dispatchingQueuedMessageIdAtom, useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { resolveComposerThreadGoalCommand } from "./thread-goal-command";
import { COMMAND_GOAL_WRITE, canClaimThreadGoalMetadataWrite } from "./thread-goal-metadata-write";
import { useAtomCommand } from "./use-atom-command";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "./composer-attachment-uploads";
import {
  canConfirmThreadExperiment,
  isCurrentThreadExperimentPreviewRequest,
  isThreadExperimentConfirmationForThread,
  threadExperimentConfirmationReducer,
  threadExperimentStartInput,
  type ThreadExperimentConfirmationState,
  type ThreadExperimentPreviewRequest,
} from "../features/threads/thread-experiment-confirmation";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const upgraded = upgradeLegacyContextMessage(input.text);
  if (
    !insertComposerDraftContext(
      threadKey,
      reidentifyComposerContext(upgraded.text, upgraded.records, uuidv4),
    )
  ) {
    Alert.alert("Too many context items", "Remove some context from the draft and try again.");
    return;
  }
  if (input.attachments && input.attachments.length > 0) {
    // Capped: a review comment is new content, not a send-failure restore, so
    // it must not push the draft over the send limit. Overflow is released.
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments, {
      appendReference: true,
    });
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const {
    selectedThread: selectedThreadShell,
    selectedThreadCreation,
    selectedEnvironmentRuntime,
  } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const acknowledgedMessages = useAtomValue(acknowledgedThreadMessagesAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setThreadGoalLoop = useAtomCommand(threadEnvironment.setGoalLoop, {
    reportFailure: false,
  });
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const previewThreadExperiment = useAtomCommand(threadEnvironment.experimentPreview, {
    reportFailure: false,
  });
  const startThreadExperiment = useAtomCommand(threadEnvironment.experimentStart, {
    reportFailure: false,
  });

  const [threadExperimentConfirmationState, dispatchThreadExperimentConfirmation] = useReducer(
    threadExperimentConfirmationReducer,
    null,
  );
  const threadExperimentConfirmationStateRef = useRef<ThreadExperimentConfirmationState | null>(
    null,
  );
  threadExperimentConfirmationStateRef.current = threadExperimentConfirmationState;
  const submittedExperimentDraftRef = useRef<{
    readonly threadKey: string;
    readonly draft: ReturnType<typeof getComposerDraftSnapshot>;
  } | null>(null);
  const nextExperimentPreviewRequestIdRef = useRef(0);
  const experimentPreviewRequestRef = useRef<ThreadExperimentPreviewRequest | null>(null);

  // ── Codex execution goal ── Provider-owned live session state, pulled
  // via the three execution-goal RPCs only; never the thread metadata path
  // the T3 goal editor above uses.
  const [executionGoalPanelState, dispatchExecutionGoalPanel] = useReducer(
    executionGoalPanelReducer,
    null,
  );
  const executionGoalStateRef = useRef<ExecutionGoalPanelState | null>(null);
  executionGoalStateRef.current = executionGoalPanelState;
  const executionGoalGet = useAtomCommand(threadEnvironment.executionGoalGet, {
    reportFailure: false,
  });
  const executionGoalPause = useAtomCommand(threadEnvironment.executionGoalPause, {
    reportFailure: false,
  });
  const executionGoalClear = useAtomCommand(threadEnvironment.executionGoalClear, {
    reportFailure: false,
  });
  const executionGoalController = useMemo(
    () =>
      createExecutionGoalPanelController({
        commands: {
          get: executionGoalGet,
          pause: executionGoalPause,
          clear: executionGoalClear,
        },
        dispatch: dispatchExecutionGoalPanel,
        state: () => executionGoalStateRef.current,
      }),
    [executionGoalGet, executionGoalPause, executionGoalClear],
  );

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadKeyRef = useRef(selectedThreadKey);
  selectedThreadKeyRef.current = selectedThreadKey;
  // The creation entry is the thread itself (rendered as the first message),
  // not a follow-up waiting behind it.
  const selectedThreadQueuedMessages = useMemo(
    () =>
      selectedThreadKey
        ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []).filter(
            (message) => message.creation === undefined,
          )
        : [],
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const feedbackSubmissions = useMemo(
    () => (selectedThreadKey ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? []) : []),
    [feedbackSubmissionsByThreadKey, selectedThreadKey],
  );
  const dismissFeedback = useCallback(
    (id: MessageId) => {
      if (!selectedThreadKey) return;
      setFeedbackSubmissionsByThreadKey((current) => ({
        ...current,
        [selectedThreadKey]: (current[selectedThreadKey] ?? []).filter((entry) => entry.id !== id),
      }));
    },
    [selectedThreadKey],
  );
  const selectedThreadMessages = selectedThreadDetail?.messages;
  const selectedThreadActivities = selectedThreadDetail?.activities;
  // A thread whose creation has not delivered its turn yet: the prompt only
  // exists in the outbox, so it is appended to whatever the server has. The
  // detail is usually present but empty during a worktree checkout, so this
  // cannot be an either/or with the loaded messages.
  const pendingCreationMessage = selectedThreadCreation?.message ?? null;
  const selectedThreadFeed = useMemo(() => {
    const loadedMessages = selectedThreadMessages ?? [];
    const feed =
      (selectedThreadMessages && selectedThreadActivities) || pendingCreationMessage !== null
        ? buildThreadFeed({
            messages:
              pendingCreationMessage !== null &&
              !loadedMessages.some((message) => message.id === pendingCreationMessage.messageId)
                ? [...loadedMessages, pendingThreadCreationMessage(pendingCreationMessage)]
                : loadedMessages,
            activities: selectedThreadActivities ?? [],
          })
        : [];
    const pendingAcknowledgments = acknowledgedMessages.filter(
      (message) =>
        scopedThreadKey(message.environmentId, message.threadId) === selectedThreadKey &&
        !selectedThreadQueuedMessages.some((queued) => queued.messageId === message.messageId),
    );
    if (pendingAcknowledgments.length === 0) return feed;
    return appendPendingThreadMessages(feed, feed, pendingAcknowledgments).map((entry) =>
      entry.pendingMessage ? { ...entry, acknowledged: true } : entry,
    );
  }, [
    selectedThreadActivities,
    selectedThreadMessages,
    pendingCreationMessage,
    selectedThreadKey,
    selectedThreadQueuedMessages,
    acknowledgedMessages,
  ]);
  useEffect(() => {
    const echoedIds = new Set(selectedThreadMessages?.map((message) => message.id));
    if (acknowledgedMessages.some((message) => echoedIds.has(message.messageId))) {
      appAtomRegistry.set(
        acknowledgedThreadMessagesAtom,
        appAtomRegistry
          .get(acknowledgedThreadMessagesAtom)
          .filter((message) => !echoedIds.has(message.messageId)),
      );
    }
  }, [acknowledgedMessages, selectedThreadMessages]);

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  // Blocked queued entries (legacy /goal text) never deliver, so they must not
  // count toward "will send automatically"; they surface separately with a
  // removal affordance instead.
  const selectedThreadBlockedQueued = useMemo(
    () => blockedQueuedThreadMessages(selectedThreadQueuedMessages),
    [selectedThreadQueuedMessages],
  );
  const selectedThreadQueueCount =
    selectedThreadQueuedMessages.length - selectedThreadBlockedQueued.length;
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const selectedProvider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection?.instanceId,
  );
  const interactionMode = selectedThread
    ? resolveProviderInteractionMode(
        selectedProvider,
        selectedDraft?.interactionMode ?? selectedThread.interactionMode,
      )
    : null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const isCompacting = useMemo(() => {
    const queuedMessage = selectedThreadQueuedMessages.findLast(
      (message) =>
        message.messageId === dispatchingQueuedMessageId &&
        message.text.trim().toLowerCase() === "/compact" &&
        message.attachments.length === 0,
    );
    const latestCompactMessage = selectedThreadDetail?.messages.findLast(
      (message) =>
        message.role === "user" &&
        message.text.trim().toLowerCase() === "/compact" &&
        !message.attachments?.length,
    );
    const compactRequestIsActive =
      latestCompactMessage !== undefined &&
      (latestCompactMessage.createdAt >
        (selectedThread?.latestTurn?.requestedAt ?? latestCompactMessage.createdAt) ||
        (selectedThread?.latestTurn?.state === "running" &&
          latestCompactMessage.createdAt === selectedThread.latestTurn.requestedAt));
    const compactionSettled = selectedThreadDetail?.activities.some((activity) => {
      if (!["context-compaction", "provider.turn.start.failed"].includes(activity.kind))
        return false;
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as { readonly requestId?: unknown })
          : null;
      return payload?.requestId === latestCompactMessage?.id;
    });
    return (
      queuedMessage !== undefined ||
      ((selectedThread?.session?.status === "starting" ||
        selectedThread?.session?.status === "running") &&
        compactRequestIsActive &&
        !compactionSettled)
    );
  }, [
    dispatchingQueuedMessageId,
    selectedThread,
    selectedThreadDetail,
    selectedThreadQueuedMessages,
  ]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  // ── Thread goal editor ── Keyed by the thread it opened for; remote goal
  // updates only follow a clean draft, and switching threads closes it.
  const [threadGoalEditorState, dispatchThreadGoalEditor] = useReducer(
    threadGoalEditorReducer,
    null,
  );
  // Holds the epoch of the editor save that owns the in-flight write slot,
  // COMMAND_GOAL_WRITE for the typed /goal command, or null when idle, so a
  // rapid Enter can never interleave a set with a clear. A reopened editor's
  // save (new epoch) supersedes a hung stale one instead of being swallowed
  // by it.
  // ponytail: a superseded write can still land server-side after the newer
  // one; the server's command queue serializes them — cancel the RPC instead
  // if strict ordering ever needs to hold.
  const goalMetadataInFlightRef = useRef<number | null>(null);
  // Serializes the whole delete sequence (pause → interrupt → clear): a
  // second Clear tap must not re-run the stop sequence while the first is
  // mid-flight. The metadata write itself keeps its own epoch slot above.
  const goalDeleteInFlightRef = useRef(false);
  const selectedThreadGoal = (selectedThreadDetail ?? selectedThreadShell)?.goal ?? null;
  useEffect(() => {
    if (!threadGoalEditorState || !selectedThreadKey) return;
    if (threadGoalEditorState.threadKey !== selectedThreadKey) {
      dispatchThreadGoalEditor({ type: "close" });
      return;
    }
    dispatchThreadGoalEditor({
      type: "remoteUpdate",
      threadKey: selectedThreadKey,
      goal: selectedThreadGoal,
    });
  }, [selectedThreadGoal, selectedThreadKey, threadGoalEditorState]);

  const openThreadGoalEditor = useCallback(() => {
    if (!selectedThreadShell) return;
    dispatchThreadGoalEditor({
      type: "open",
      epoch: nextThreadGoalEditorEpoch(),
      threadKey: scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id),
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      goal: (selectedThreadDetail ?? selectedThreadShell)?.goal ?? null,
    });
  }, [selectedThreadDetail, selectedThreadShell]);

  const changeThreadGoalDraft = useCallback((text: string) => {
    dispatchThreadGoalEditor({ type: "setDraft", text });
  }, []);

  const writeThreadGoalFromEditor = useCallback(
    async (goal: string | null) => {
      const state = threadGoalEditorState;
      // Only the current editor generation may claim the write slot: a
      // same-generation save (or the typed /goal command) is already in
      // flight. A stale generation's hung request does not block — this save
      // supersedes it and the stale completion is ignored by epoch below.
      if (
        !state ||
        !canClaimThreadGoalMetadataWrite(goalMetadataInFlightRef.current, state.epoch)
      ) {
        return;
      }
      dispatchThreadGoalEditor({ type: "beginSave" });
      goalMetadataInFlightRef.current = state.epoch;
      const saveEpoch = state.epoch;
      const result = await updateThreadMetadata({
        environmentId: state.environmentId,
        input: { threadId: state.threadId, goal },
      });
      // Release the slot only while this request still owns it, so a late
      // stale completion cannot clear a newer save's claim.
      if (goalMetadataInFlightRef.current === saveEpoch) goalMetadataInFlightRef.current = null;
      // Completion events carry the thread and generation the RPC was issued
      // for, so a late reply — for another thread, or for this thread before
      // a close/reopen — can neither mutate nor close the current editor.
      const saveThreadKey = state.threadKey;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = Cause.squash(result.cause);
          dispatchThreadGoalEditor({
            type: "saveFailure",
            threadKey: saveThreadKey,
            epoch: saveEpoch,
            error: error instanceof Error ? error.message : "An error occurred.",
          });
        } else {
          dispatchThreadGoalEditor({
            type: "saveFailure",
            threadKey: saveThreadKey,
            epoch: saveEpoch,
            error: "Try again.",
          });
        }
        return;
      }
      dispatchThreadGoalEditor({
        type: "saveSuccess",
        threadKey: saveThreadKey,
        epoch: saveEpoch,
        goal,
      });
      if (goal !== null) {
        dispatchThreadGoalEditor({ type: "close", threadKey: saveThreadKey, epoch: saveEpoch });
      }
    },
    [threadGoalEditorState, updateThreadMetadata],
  );

  const saveThreadGoalFromEditor = useCallback(() => {
    if (
      !threadGoalEditorState ||
      !threadGoalEditorCanSave(threadGoalEditorState) ||
      // A delete in flight owns the goal write slot: a save racing it could
      // land between the delete's pause/interrupt and its clear.
      goalDeleteInFlightRef.current
    ) {
      return;
    }
    void writeThreadGoalFromEditor(threadGoalEditorState.draft);
  }, [threadGoalEditorState, writeThreadGoalFromEditor]);

  const clearThreadGoalFromEditor = useCallback(async () => {
    const state = threadGoalEditorState;
    if (!state || state.savedGoal === null || goalDeleteInFlightRef.current) return;
    // A reopened editor may supersede an older editor save. The current
    // editor's own save and a typed /goal command still keep ownership.
    if (!canClaimThreadGoalMetadataWrite(goalMetadataInFlightRef.current, state.epoch)) return;
    const shell = selectedThreadShell;
    // Deleting a goal that is driving work must stop that work first: pause
    // the loop (so no continuation can start mid-sequence), interrupt the
    // running turn, then clear. A goal that is not driving anything clears
    // directly — and a draft goal is local only, never a server write.
    if (shell == null || shell.id !== state.threadId) {
      void writeThreadGoalFromEditor(null);
      return;
    }
    const turnActive = shell.session?.status === "running" || shell.session?.status === "starting";
    if (shell.goalLoop == null && !turnActive) {
      void writeThreadGoalFromEditor(null);
      return;
    }
    goalDeleteInFlightRef.current = true;
    try {
      await deleteThreadGoalWork({
        loop: shell.goalLoop ?? null,
        pauseGoalLoop: async () => {
          const result = await setThreadGoalLoop({
            environmentId: shell.environmentId,
            input: { threadId: shell.id, action: "pause" },
          });
          if (result._tag === "Failure") {
            if (!isAtomCommandInterrupted(result)) {
              const error = Cause.squash(result.cause);
              Alert.alert(
                "Could not pause the goal loop",
                error instanceof Error ? error.message : "An error occurred.",
              );
            }
            return false;
          }
          return true;
        },
        interruptActiveTurn: async () => {
          if (!turnActive) return true;
          // An interrupt failure still clears: removing the goal is the point
          // of delete; the current turn merely finishes on its own.
          const result = await interruptThreadTurn({
            environmentId: shell.environmentId,
            input: {
              threadId: shell.id,
              ...(shell.session?.activeTurnId ? { turnId: shell.session.activeTurnId } : {}),
            },
          });
          return result._tag === "Success";
        },
        clearGoal: async () => {
          // Clear failures surface through the editor state the sheet renders.
          await writeThreadGoalFromEditor(null);
          return true;
        },
      });
    } finally {
      goalDeleteInFlightRef.current = false;
    }
  }, [
    threadGoalEditorState,
    selectedThreadShell,
    // eslint-disable-next-line react/memo-dependencies -- read only inside closures handed to deleteThreadGoalWork, which the compiler cannot see through; dropping it would let the pause run stale.
    setThreadGoalLoop,
    interruptThreadTurn,
    writeThreadGoalFromEditor,
  ]);

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }
    // The server has not created this thread yet. Queuing a follow-up against
    // its id would strand the message: if the creation is rejected the thread
    // never appears and the drain drops the orphan. The composer disables its
    // send button too; this guard also covers the editor's submit key.
    if (selectedThreadCreation !== null) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    if (appAtomRegistry.get(composerContextImportsAtom)[threadKey]) return null;
    const thread = selectedThreadDetail ?? selectedThreadShell;
    // Parse the raw draft and send the same policy-trimmed text so the two
    // cannot drift: native String.trim removes U+FEFF, which the /goal
    // delimiter policy keeps as content, so it would reclassify a FEFF-joined
    // ordinary draft as "/goal …" outbox text that can never deliver.
    const goalSubmission = resolveComposerThreadGoalCommand({
      text: draft.text,
      attachmentCount: draft.attachments.length,
      context: draft.context,
      capabilityKnown: selectedEnvironmentRuntime?.serverConfig != null,
      supportsThreadGoals:
        selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.threadGoals === true,
    });
    const goalCommand = goalSubmission?.command ?? null;
    const text = trimThreadGoalWhitespace(draft.text);
    const attachments = draft.attachments;
    if (
      !goalCommand &&
      composerAttachmentUploadBlockReason({
        environmentId: selectedThreadShell.environmentId,
        attachments,
        connected: selectedEnvironmentRuntime?.connectionState === "connected",
        serverConfig: selectedEnvironmentRuntime?.serverConfig ?? null,
        states: appAtomRegistry.get(composerAttachmentUploadsAtom),
      }) !== null
    )
      return null;
    // Policy whitespace only: a FEFF-only draft stays invisible, a no-op.
    if (!hasVisibleThreadGoalText(text) && attachments.length === 0) {
      return null;
    }
    // A send-failure restore appends with allowOverflow so it never drops the
    // user's files, which can leave the draft over the cap. Sending it anyway
    // would enqueue a message that outbox recovery rejects forever, so block
    // here until the user removes attachments.
    if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Alert.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return null;
    }

    const contextBlockReason = composerContextSendBlockReason(draft.context);
    if (contextBlockReason) {
      Alert.alert("Too much context", contextBlockReason);
      return null;
    }

    const modelSelection = draft.modelSelection ?? thread.modelSelection;
    const serverConfig = selectedEnvironmentRuntime?.serverConfig;
    if (
      selectedEnvironmentRuntime?.connectionState === "connected" &&
      isModelSelectionUnavailable(serverConfig, modelSelection)
    ) {
      Alert.alert(
        "Antigravity model unavailable",
        "Set up Antigravity on web or desktop, or choose another model.",
      );
      return null;
    }
    const provider = serverConfig?.providers.find(
      (entry) => entry.instanceId === modelSelection.instanceId,
    );
    if (goalCommand) {
      // Shared block-reason matrix with web: attachments first, then unknown
      // capability (still connecting) kept separate from known-unsupported.
      const goalBlockReason = goalSubmission?.blockReason ?? null;
      if (goalBlockReason === "attachments") {
        Alert.alert(
          "Remove attachments to use /goal",
          "Thread goal commands cannot include attachments. Your draft was kept.",
        );
        return null;
      }
      if (goalBlockReason === "context") {
        Alert.alert(
          "Remove context to use /goal",
          "Thread goal commands cannot include context. Your draft was kept.",
        );
        return null;
      }
      if (goalBlockReason === "unavailable") {
        Alert.alert(
          "Still connecting to the environment",
          "Wait for the connection, then try /goal again. Your draft was kept.",
        );
        return null;
      }
      if (goalBlockReason === "unsupported") {
        Alert.alert(
          "Thread goals are unavailable",
          "Update the connected T3 Code server before using /goal. Your draft was kept.",
        );
        return null;
      }
      if (goalCommand.action === "experiment") {
        const objectiveError = threadExperimentObjectiveError(goalCommand.objective);
        if (objectiveError !== null) {
          Alert.alert("Experiment needs an objective", objectiveError);
          return null;
        }
        const previewRequest = {
          id: nextExperimentPreviewRequestIdRef.current + 1,
          threadKey,
        };
        if (experimentPreviewRequestRef.current?.threadKey === threadKey) return null;
        nextExperimentPreviewRequestIdRef.current = previewRequest.id;
        experimentPreviewRequestRef.current = previewRequest;
        const result = await previewThreadExperiment({
          environmentId: selectedThreadShell.environmentId,
          input: { threadId: selectedThreadShell.id, objective: goalCommand.objective },
        });
        if (
          !isCurrentThreadExperimentPreviewRequest(
            previewRequest,
            experimentPreviewRequestRef.current,
            selectedThreadKeyRef.current,
          )
        ) {
          return null;
        }
        experimentPreviewRequestRef.current = null;
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = Cause.squash(result.cause);
            Alert.alert(
              "Could not preview experiment",
              error instanceof Error
                ? error.message
                : "Check the experiment configuration and try again.",
            );
          }
          return null;
        }
        submittedExperimentDraftRef.current = { threadKey, draft };
        dispatchThreadExperimentConfirmation({
          type: "open",
          threadKey,
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          objective: goalCommand.objective,
          preview: result.value,
        });
        return null;
      }
      if (goalCommand.action === "set" && goalCommand.goal.length > THREAD_GOAL_MAX_CHARS) {
        Alert.alert("Goal is too long", `Keep it under ${THREAD_GOAL_MAX_CHARS} characters.`);
        return null;
      }
      if (goalCommand.action === "set" && !hasVisibleThreadGoalText(goalCommand.goal)) {
        Alert.alert(
          "Goal needs visible text",
          "Spaces and zero-width characters don't count. Write something you can read.",
        );
        return null;
      }
      if (goalCommand.action === "show") {
        // Bare /goal opens the goal editor prefilled instead of a read-only
        // alert, mirroring the composer pill.
        dispatchThreadGoalEditor({
          type: "open",
          epoch: nextThreadGoalEditorEpoch(),
          threadKey,
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          goal: thread.goal ?? null,
        });
        clearComposerDraftContent(threadKey);
        return null;
      }
      if (goalMetadataInFlightRef.current !== null) {
        return null;
      }
      const goalValue = goalCommand.action === "set" ? goalCommand.goal : null;
      goalMetadataInFlightRef.current = COMMAND_GOAL_WRITE;
      const result = await updateThreadMetadata({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, goal: goalValue },
      });
      if (goalMetadataInFlightRef.current === COMMAND_GOAL_WRITE) {
        goalMetadataInFlightRef.current = null;
      }
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return null;
        }
        const error = Cause.squash(result.cause);
        Alert.alert(
          goalValue === null ? "Could not clear thread goal" : "Could not set thread goal",
          error instanceof Error ? error.message : "An error occurred.",
        );
        return null;
      }
      clearComposerDraftContentIfUnchanged(threadKey, draft);
      return null;
    }
    const feedbackCommand =
      attachments.length === 0 &&
      (draft.context?.records.length ?? 0) === 0 &&
      (provider?.driver === "codex" || thread.session?.providerName === "codex")
        ? parseCodexFeedbackCommand(text)
        : null;
    if (feedbackCommand) {
      if (thread.session === null) {
        Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
        return null;
      }
      const metadata = makeQueuedMessageMetadata();
      await submitCodexFeedback({
        submission: {
          id: MessageId.make(metadata.messageId),
          command: text,
          createdAt: metadata.createdAt,
        },
        clearDraft: () => clearComposerDraftContent(threadKey),
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[threadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [threadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: selectedThreadShell.environmentId,
            input: {
              threadId: selectedThreadShell.id,
              ...feedbackCommand,
            },
          }),
      });
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    // Enqueue publishes the queued atom synchronously (the durable write
    // happens behind it), so clearing the draft here gives send feedback on
    // the tap frame instead of after file I/O. If the write fails the message
    // is rolled out of the queue and the content is merged back into the
    // draft, preserving anything typed since.
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      context: draft.context,
      modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: resolveProviderInteractionMode(
        provider,
        draft.interactionMode ?? thread.interactionMode,
      ),
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
    enqueuePromise.then(
      () => {
        // The queued message owns the files now; the sweep sees that and
        // spares them. Deferred to here so a failed write cannot roll the
        // message out of the queue mid-sweep and lose the bytes.
        scheduleUnusedComposerAttachmentCleanup(attachments);
      },
      (error: unknown) => {
        // Restore text via merge (idempotent) but attachments via the uncapped
        // append: the merge path slots existing attachments first and truncates
        // at the send limit, which would silently drop this message's images if
        // the user attached new ones while the write was in flight.
        void mergeComposerDraftContent(threadKey, {
          text,
          context: draft.context,
          attachments: [],
        });
        appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to save the queued message.",
        );
      },
    );
    return messageId;
  }, [
    dispatchThreadGoalEditor,
    selectedEnvironmentRuntime?.connectionState,
    selectedEnvironmentRuntime?.serverConfig,
    selectedThreadCreation,
    selectedThreadDetail,
    selectedThreadShell,
    previewThreadExperiment,
    updateThreadMetadata,
    uploadThreadFeedback,
  ]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftMedia = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments, {
      appendReference: true,
    });
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPickDraftFiles = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }
    const maxBytes =
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments
        ?.maxUploadBytes;
    if (maxBytes === undefined) {
      Alert.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    // pickComposerFiles clamps the advertised limit to the contract maximum.
    const result = await pickComposerFiles({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files, {
      appendReference: true,
    });
    // The picker error and the live-cap rejection can both happen in one
    // pick; report both in a single alert.
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach file", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images, {
      appendReference: true,
    });
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    } else if (rejectedPasteCount > 0) {
      setPendingConnectionError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images, { appendReference: true });
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === value.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        modelSelection: value,
        ...(provider?.showInteractionModeToggle === false
          ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
          : {}),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      const modelSelection =
        getComposerDraftSnapshot(selectedThreadKey).modelSelection ??
        selectedThread?.modelSelection;
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === modelSelection?.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        interactionMode: resolveProviderInteractionMode(provider, value),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThread?.modelSelection, selectedThreadKey],
  );

  const closeThreadGoalEditor = useCallback(() => {
    dispatchThreadGoalEditor({ type: "close" });
  }, []);

  const onThreadGoalLoopAction = useCallback(
    async (action: ThreadGoalLoopAction) => {
      if (!selectedThreadShell) return;
      const result = await setThreadGoalLoop({
        environmentId: selectedThreadShell.environmentId,
        input: {
          threadId: selectedThreadShell.id,
          action: action === "continue" ? "reset" : action,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not update the goal loop",
          error instanceof Error ? error.message : "An error occurred.",
        );
      }
    },
    [selectedThreadShell, setThreadGoalLoop],
  );

  useEffect(() => {
    experimentPreviewRequestRef.current = null;
    const confirmation = threadExperimentConfirmationStateRef.current;
    if (confirmation && confirmation.threadKey !== selectedThreadKey) {
      submittedExperimentDraftRef.current = null;
      dispatchThreadExperimentConfirmation({ type: "cancel" });
    }
  }, [selectedThreadKey]);

  const cancelThreadExperimentConfirmation = useCallback(() => {
    if (threadExperimentConfirmationStateRef.current?.confirming) return;
    submittedExperimentDraftRef.current = null;
    dispatchThreadExperimentConfirmation({ type: "cancel" });
  }, []);

  const confirmThreadExperiment = useCallback(async () => {
    const confirmation = threadExperimentConfirmationStateRef.current;
    if (!canConfirmThreadExperiment(confirmation)) return;
    if (!isThreadExperimentConfirmationForThread(confirmation, selectedThreadKeyRef.current)) {
      submittedExperimentDraftRef.current = null;
      dispatchThreadExperimentConfirmation({ type: "cancel" });
      return;
    }
    dispatchThreadExperimentConfirmation({ type: "beginConfirm" });
    const result = await startThreadExperiment({
      environmentId: confirmation.environmentId,
      input: threadExperimentStartInput(confirmation),
    });
    if (result._tag === "Failure") {
      const error = isAtomCommandInterrupted(result) ? null : Cause.squash(result.cause);
      dispatchThreadExperimentConfirmation({
        type: "confirmFailure",
        error:
          error instanceof Error
            ? error.message
            : isAtomCommandInterrupted(result)
              ? "The experiment start was interrupted. Review the configuration and try again."
              : "The experiment could not start. Review the configuration and try again.",
      });
      return;
    }

    const submitted = submittedExperimentDraftRef.current;
    dispatchThreadExperimentConfirmation({ type: "cancel" });
    submittedExperimentDraftRef.current = null;
    if (submitted) clearComposerDraftContentIfUnchanged(submitted.threadKey, submitted.draft);
  }, [startThreadExperiment]);

  // Switching threads closes the execution-goal sheet: it belongs to the
  // thread's live Codex session.
  useEffect(() => {
    if (!executionGoalPanelState || !selectedThreadKey) return;
    if (executionGoalPanelState.threadKey !== selectedThreadKey) {
      dispatchExecutionGoalPanel({ type: "close" });
    }
  }, [executionGoalPanelState, selectedThreadKey]);

  const openExecutionGoalPanel = useCallback(() => {
    if (!selectedThreadShell) return;
    const target = {
      threadKey: scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id),
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
    };
    dispatchExecutionGoalPanel({ type: "open", ...target });
    void executionGoalController.fetch(target);
  }, [executionGoalController, selectedThreadShell]);

  const refreshExecutionGoalPanel = useCallback(() => {
    const state = executionGoalStateRef.current;
    if (!state || !executionGoalCanRefresh(state)) return;
    dispatchExecutionGoalPanel({ type: "beginRefresh", threadKey: state.threadKey });
    void executionGoalController.fetch({
      threadKey: state.threadKey,
      environmentId: state.environmentId,
      threadId: state.threadId,
    });
  }, [executionGoalController]);

  const pauseExecutionGoalPanel = useCallback(() => {
    void executionGoalController.pause();
  }, [executionGoalController]);

  const clearExecutionGoalPanel = useCallback(() => {
    void executionGoalController.clear();
  }, [executionGoalController]);

  const closeExecutionGoalPanel = useCallback(() => {
    dispatchExecutionGoalPanel({ type: "close" });
  }, []);

  const onRemoveBlockedQueuedMessage = useCallback((message: QueuedThreadMessage) => {
    void removeThreadOutboxMessage(message).catch((error: unknown) => {
      console.warn("[thread-outbox] failed to remove blocked /goal message", {
        messageId: message.messageId,
        ...safeErrorLogAttributes(error),
      });
    });
  }, []);

  /**
   * Manual context compaction for the selected thread: queues `/compact`
   * through the ordinary turn pipeline (the durable outbox), same as any
   * other message. The server decides internally how the provider actually
   * compacts; the client only ever asks for it as a slash command.
   */
  const onCompactContext = useCallback(() => {
    if (!selectedThreadShell) {
      return;
    }
    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const session = selectedThreadDetail ?? selectedThreadShell;
    if (
      draft.text.trim().length > 0 ||
      draft.attachments.length > 0 ||
      session.session?.status === "running" ||
      session.session?.status === "starting"
    ) {
      Alert.alert(
        "Finish the current work first",
        "Send or clear your message and stop the running turn before compacting.",
      );
      return;
    }
    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text: "/compact",
      attachments: [],
      modelSelection: session.modelSelection,
      runtimeMode: session.runtimeMode,
      interactionMode: session.interactionMode,
      createdAt: metadata.createdAt,
    });
    enqueuePromise.catch((error: unknown) => {
      Alert.alert(
        "Could not queue /compact",
        error instanceof Error ? error.message : "An error occurred.",
      );
    });
  }, [selectedThreadDetail, selectedThreadShell]);

  return {
    feedbackSubmissions,
    dismissFeedback,
    selectedThreadFeed,
    selectedThreadQueueCount,
    selectedThreadBlockedQueued,
    selectedThreadQueuedMessages,
    dispatchingQueuedMessageId,
    activeWorkStartedAt,
    isCompacting,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    threadGoalEditorState,
    openThreadGoalEditor,
    changeThreadGoalDraft,
    saveThreadGoalFromEditor,
    clearThreadGoalFromEditor,
    closeThreadGoalEditor,
    onThreadGoalLoopAction,
    threadExperimentConfirmationState,
    cancelThreadExperimentConfirmation,
    confirmThreadExperiment,
    executionGoalPanelState,
    openExecutionGoalPanel,
    refreshExecutionGoalPanel,
    pauseExecutionGoalPanel,
    clearExecutionGoalPanel,
    closeExecutionGoalPanel,
    onRemoveBlockedQueuedMessage,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onCompactContext,
    onSendMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
