import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { RefreshCwIcon } from "lucide-react";
import { create } from "zustand";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  createExecutionGoalPanelController,
  executionGoalCanClear,
  executionGoalCanPause,
  executionGoalCanRefresh,
  executionGoalDurationLabel,
  executionGoalErrorCopy,
  executionGoalPanelReducer,
  executionGoalStatusLabel,
  executionGoalTokensLabel,
  type ExecutionGoalPanelState,
} from "@t3tools/client-runtime/state/executionGoalPanel";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";

/**
 * Codex-native execution goal panel — a read-only-with-actions escape hatch
 * onto provider-owned live session state. Never touches the pinned T3 thread
 * goal: the only wire calls it can make are the three execution-goal RPCs
 * (see createExecutionGoalPanelController).
 */

interface ExecutionGoalDialogStore {
  readonly target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  readonly open: (ref: ScopedThreadRef) => void;
  readonly close: () => void;
}

const useExecutionGoalDialogStore = create<ExecutionGoalDialogStore>((set) => ({
  target: null,
  open: (ref) => set({ target: { environmentId: ref.environmentId, threadId: ref.threadId } }),
  close: () => set({ target: null }),
}));

/** Opens the execution-goal panel for a thread from any surface (header menu, sidebar). */
export const openExecutionGoalDialog = (ref: ScopedThreadRef) =>
  useExecutionGoalDialogStore.getState().open(ref);

const UPDATED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export const CodexExecutionGoalDialogHost = () => {
  const target = useExecutionGoalDialogStore((state) => state.target);
  if (target === null) return null;
  return (
    <CodexExecutionGoalDialog
      key={`${target.environmentId}:${target.threadId}`}
      environmentId={target.environmentId}
      threadId={target.threadId}
      onClose={() => useExecutionGoalDialogStore.getState().close()}
    />
  );
};

function CodexExecutionGoalDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId, onClose } = props;
  const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const [state, dispatch] = useReducer(executionGoalPanelReducer, null);
  const stateRef = useRef<ExecutionGoalPanelState | null>(null);
  stateRef.current = state;
  const getCommand = useAtomCommand(threadEnvironment.executionGoalGet, { reportFailure: false });
  const pauseCommand = useAtomCommand(threadEnvironment.executionGoalPause, {
    reportFailure: false,
  });
  const clearCommand = useAtomCommand(threadEnvironment.executionGoalClear, {
    reportFailure: false,
  });
  const targetRef = useRef({ threadKey, environmentId, threadId });
  targetRef.current = { threadKey, environmentId, threadId };
  const controller = useMemo(
    () =>
      createExecutionGoalPanelController({
        commands: { get: getCommand, pause: pauseCommand, clear: clearCommand },
        dispatch,
        state: () => stateRef.current,
      }),
    [getCommand, pauseCommand, clearCommand],
  );

  useEffect(() => {
    const target = targetRef.current;
    dispatch({
      type: "open",
      threadKey: target.threadKey,
      environmentId: target.environmentId,
      threadId: target.threadId,
    });
    void controller.fetch(target);
    // The dialog is keyed per thread; fetch-once per mount is the contract.
  }, [controller]);

  const refresh = useCallback(() => {
    const current = stateRef.current;
    if (current === null || !executionGoalCanRefresh(current)) return;
    dispatch({ type: "beginRefresh", threadKey: current.threadKey });
    void controller.fetch(targetRef.current);
  }, [controller]);

  const pause = useCallback(() => {
    void controller.pause();
  }, [controller]);

  const clear = useCallback(() => {
    const current = stateRef.current;
    if (current === null || !executionGoalCanClear(current)) return;
    void (async () => {
      const api = readLocalApi();
      if (api) {
        const confirmed = await settlePromise(() =>
          api.dialogs.confirm(
            [
              "Clear Codex's execution goal for this thread?",
              "Codex stops tracking it in this session. Your T3 thread goal is not affected.",
            ].join("\n"),
            { variant: "destructive" },
          ),
        );
        if (confirmed._tag === "Failure" || !confirmed.value) return;
      }
      await controller.clear();
    })();
  }, [controller]);

  if (state === null) return null;

  const errorCopy = state.error !== null ? executionGoalErrorCopy(state.error) : null;
  const snapshot = state.snapshot;

  return (
    <Dialog open onOpenChange={(open) => void (!open && onClose())}>
      <DialogPopup className="max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>Codex execution goal</DialogTitle>
          <DialogDescription>
            Set and tracked by Codex in this session. Separate from your thread goal.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          {state.status === "loading" && !snapshot ? (
            <p className="text-sm text-muted-foreground">Reading Codex's live goal…</p>
          ) : snapshot === null ? (
            <p className="text-sm text-muted-foreground">
              Codex has no execution goal for this thread.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 text-sm text-foreground">{snapshot.objective}</p>
                <span
                  className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground"
                  aria-label={`Status: ${executionGoalStatusLabel(snapshot.status)}`}
                >
                  {executionGoalStatusLabel(snapshot.status)}
                </span>
              </div>
              <dl className="space-y-1 text-xs text-muted-foreground">
                <div className="flex gap-2">
                  <dt className="shrink-0">Tokens</dt>
                  <dd className="min-w-0">{executionGoalTokensLabel(snapshot)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0">Time used</dt>
                  <dd className="min-w-0">
                    {executionGoalDurationLabel(snapshot.timeUsedSeconds)}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0">Updated</dt>
                  {/* Provider's own updatedAt is the only freshness signal;
                      stale reads are refreshed explicitly, never auto-polled. */}
                  <dd className="min-w-0">
                    {UPDATED_AT_FORMAT.format(new Date(snapshot.updatedAt))}
                  </dd>
                </div>
              </dl>
            </div>
          )}
          {errorCopy !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {errorCopy.title}. {errorCopy.description}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={!executionGoalCanRefresh(state)} onClick={refresh}>
            <RefreshCwIcon aria-hidden className="size-3.5" />
            {state.refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          {snapshot?.status === "active" ? (
            <Button variant="outline" disabled={!executionGoalCanPause(state)} onClick={pause}>
              {state.action === "pausing" ? "Pausing…" : "Pause"}
            </Button>
          ) : null}
          {snapshot !== null ? (
            <Button variant="outline" disabled={!executionGoalCanClear(state)} onClick={clear}>
              {state.action === "clearing" ? "Clearing…" : "Clear"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
