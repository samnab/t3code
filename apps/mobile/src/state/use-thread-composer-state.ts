import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";

import {
  CommandId,
  MessageId,
  THREAD_GOAL_MAX_CHARS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  hasVisibleThreadGoalText,
  parseThreadGoalCommand,
  trimThreadGoalWhitespace,
} from "@t3tools/shared/composerTrigger";
import {
  resolveThreadGoalCommandBlockReason,
  threadGoalEditorCanSave,
  threadGoalEditorReducer,
} from "@t3tools/client-runtime/state/threadGoalEditor";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  clearComposerDraftContentIfUnchanged,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
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
  removeThreadOutboxMessage,
  type QueuedThreadMessage,
} from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    appendComposerDraftAttachments(threadKey, input.attachments);
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
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const selectedThreadFeed = useMemo(() => {
    if (!selectedThreadDetail) {
      return [];
    }
    const submissions = selectedThreadKey
      ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? [])
      : [];
    return buildThreadFeed(selectedThreadDetail, {
      localMessages: submissions.flatMap((submission) =>
        submission.status === "interrupted"
          ? []
          : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
      ),
    });
  }, [feedbackSubmissionsByThreadKey, selectedThreadDetail, selectedThreadKey]);

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
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

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
  const goalMetadataInFlightRef = useRef(false);
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
      if (!state || goalMetadataInFlightRef.current) return;
      dispatchThreadGoalEditor({ type: "beginSave" });
      goalMetadataInFlightRef.current = true;
      const result = await updateThreadMetadata({
        environmentId: state.environmentId,
        input: { threadId: state.threadId, goal },
      });
      goalMetadataInFlightRef.current = false;
      // Completion events are keyed to the thread the RPC was issued for, so
      // a late reply cannot mutate or close an editor reopened for another
      // thread while the request was in flight.
      const saveThreadKey = state.threadKey;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = Cause.squash(result.cause);
          dispatchThreadGoalEditor({
            type: "saveFailure",
            threadKey: saveThreadKey,
            error: error instanceof Error ? error.message : "An error occurred.",
          });
        } else {
          dispatchThreadGoalEditor({
            type: "saveFailure",
            threadKey: saveThreadKey,
            error: "Try again.",
          });
        }
        return;
      }
      dispatchThreadGoalEditor({ type: "saveSuccess", threadKey: saveThreadKey, goal });
      if (goal !== null) {
        dispatchThreadGoalEditor({ type: "close", threadKey: saveThreadKey });
      }
    },
    [threadGoalEditorState, updateThreadMetadata],
  );

  const saveThreadGoalFromEditor = useCallback(() => {
    if (!threadGoalEditorState || !threadGoalEditorCanSave(threadGoalEditorState)) return;
    void writeThreadGoalFromEditor(threadGoalEditorState.draft);
  }, [threadGoalEditorState, writeThreadGoalFromEditor]);

  const clearThreadGoalFromEditor = useCallback(() => {
    if (!threadGoalEditorState || threadGoalEditorState.savedGoal === null) return;
    void writeThreadGoalFromEditor(null);
  }, [threadGoalEditorState, writeThreadGoalFromEditor]);

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    // Parse the raw draft and send the same policy-trimmed text so the two
    // cannot drift: native String.trim removes U+FEFF, which the /goal
    // delimiter policy keeps as content, so it would reclassify a FEFF-joined
    // ordinary draft as "/goal …" outbox text that can never deliver.
    const goalCommand = parseThreadGoalCommand(draft.text);
    const text = trimThreadGoalWhitespace(draft.text);
    const attachments = draft.attachments;
    // Policy whitespace only: a FEFF-only draft stays invisible, a no-op.
    if (!hasVisibleThreadGoalText(text) && attachments.length === 0) {
      return null;
    }

    const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
      (entry) => entry.instanceId === thread.modelSelection.instanceId,
    );
    if (goalCommand) {
      // Shared block-reason matrix with web: attachments first, then unknown
      // capability (still connecting) kept separate from known-unsupported.
      const goalBlockReason = resolveThreadGoalCommandBlockReason({
        isServerThread: true,
        attachmentCount: attachments.length,
        contextCount: 0,
        capabilityKnown: selectedEnvironmentRuntime?.serverConfig != null,
        supportsThreadGoals:
          selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.threadGoals === true,
      });
      if (goalBlockReason === "attachments") {
        Alert.alert(
          "Remove attachments to use /goal",
          "Thread goal commands cannot include attachments. Your draft was kept.",
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
          threadKey,
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          goal: thread.goal ?? null,
        });
        clearComposerDraftContent(threadKey);
        return null;
      }
      if (goalMetadataInFlightRef.current) {
        return null;
      }
      const goalValue = goalCommand.action === "set" ? goalCommand.goal : null;
      goalMetadataInFlightRef.current = true;
      const result = await updateThreadMetadata({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, goal: goalValue },
      });
      goalMetadataInFlightRef.current = false;
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
      (provider?.driver === "codex" || thread.session?.providerName === "codex")
        ? parseCodexFeedbackCommand(text)
        : null;
    if (feedbackCommand) {
      if (thread.session === null) {
        Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
        return null;
      }
      const metadata = makeQueuedMessageMetadata();
      const result = await submitCodexFeedback({
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
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return null;
        }
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not send feedback to OpenAI",
          error instanceof Error ? error.message : "An error occurred.",
        );
        return null;
      }
      const feedbackId = result.value.feedbackId;
      Alert.alert("Feedback sent to OpenAI", `Thread ID: ${feedbackId}`, [
        { text: "OK", style: "cancel" },
        {
          text: "Copy ID",
          onPress: () => copyTextWithHaptic(feedbackId, { target: "Codex feedback thread ID" }),
        },
      ]);
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
      modelSelection: draft.modelSelection ?? thread.modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: draft.interactionMode ?? thread.interactionMode,
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey);
    enqueuePromise.catch((error: unknown) => {
      // Restore text via merge (idempotent) but attachments via the uncapped
      // append: the merge path slots existing attachments first and truncates
      // at the send limit, which would silently drop this message's images if
      // the user attached new ones while the write was in flight.
      void mergeComposerDraftContent(threadKey, { text, attachments: [] });
      appendComposerDraftAttachments(threadKey, attachments);
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
    return messageId;
  }, [
    dispatchThreadGoalEditor,
    selectedEnvironmentRuntime?.serverConfig?.providers,
    selectedThreadDetail,
    selectedThreadShell,
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

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
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
          appendComposerDraftAttachments(threadKey, images);
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
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
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
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  const closeThreadGoalEditor = useCallback(() => {
    dispatchThreadGoalEditor({ type: "close" });
  }, []);

  const onRemoveBlockedQueuedMessage = useCallback((message: QueuedThreadMessage) => {
    void removeThreadOutboxMessage(message).catch((error: unknown) => {
      console.warn("[thread-outbox] failed to remove blocked /goal message", {
        messageId: message.messageId,
        ...safeErrorLogAttributes(error),
      });
    });
  }, []);

  const compactThreadContext = useAtomCommand(threadEnvironment.compactContext, {
    reportFailure: false,
  });
  const compactInFlightRef = useRef(false);
  /**
   * Manual context compaction for the selected thread. Prompt mode sends
   * `/compact` through the ordinary turn pipeline (the durable outbox);
   * native mode dispatches `thread.context.compact` directly — disconnected
   * requests fail here instead of queuing. The summary is always the
   * provider's own; nothing is stored locally.
   */
  const onCompactContext = useCallback(
    async (input: { readonly mode: "prompt" | "native" }) => {
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
      if (input.mode === "prompt") {
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
        return;
      }
      if (compactInFlightRef.current) {
        return;
      }
      compactInFlightRef.current = true;
      const result = await compactThreadContext({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id },
      });
      compactInFlightRef.current = false;
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Context compaction failed",
          error instanceof Error ? error.message : "The provider did not compact the thread.",
        );
      }
    },
    [compactThreadContext, selectedThreadDetail, selectedThreadShell],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    selectedThreadBlockedQueued,
    activeWorkStartedAt,
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
    onRemoveBlockedQueuedMessage,
    onChangeDraftMessage,
    onPickDraftImages,
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
