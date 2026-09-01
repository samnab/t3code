import { TargetIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { THREAD_GOAL_MAX_CHARS } from "@t3tools/contracts";
import {
  threadGoalEditorCanSave,
  threadGoalEditorDraftError,
  type ThreadGoalEditorState,
} from "@t3tools/client-runtime/state/threadGoalEditor";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

// The counter stays hidden until the draft approaches the cap, matching the
// composer's own prompt-length messaging that only appears near limits.
const GOAL_COUNTER_THRESHOLD = THREAD_GOAL_MAX_CHARS - 128;

/**
 * Inline thread-goal editor, rendered above the composer through the same
 * fixed-position layer as the stash drawer so it never clips. All state
 * lives in the parent (keyed by thread); this panel only reports intents.
 */
export const ThreadGoalEditor = memo(function ThreadGoalEditor(props: {
  state: ThreadGoalEditorState;
  onDraftChange: (text: string) => void;
  onSave: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const { state } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const draftError = threadGoalEditorDraftError(state.draft);
  const canSave = threadGoalEditorCanSave(state);

  // Capture-phase like the stash drawer: closes before editor handlers or
  // the composer's own layers can react. Clicks on the composer's goal
  // trigger toggle instead of double-closing.
  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (
        (panel && event.composedPath().includes(panel)) ||
        (event.target instanceof Element && event.target.closest("[data-thread-goal]"))
      ) {
        return;
      }
      props.onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [props.onClose]);

  return (
    <div
      ref={panelRef}
      className="chat-composer-drawer-surface chat-composer-drawer-attached relative w-full overflow-hidden"
      data-composer-goal-drawer="true"
    >
      <div className="flex h-7 items-center justify-between gap-2 px-2 pt-1">
        <span className="inline-flex min-w-0 items-center gap-1.5 px-1 text-xs font-medium text-secondary-label">
          <TargetIcon aria-hidden className="size-3 shrink-0" />
          Thread goal
        </span>
        <Button
          variant="ghost-muted"
          size="icon-micro"
          aria-label="Close goal editor"
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onClose}
        >
          <XIcon className="size-3" />
        </Button>
      </div>
      <Textarea
        autoFocus
        value={state.draft}
        maxLength={THREAD_GOAL_MAX_CHARS}
        aria-label="Thread goal"
        aria-invalid={draftError !== null || undefined}
        className="mx-2 mb-2 max-h-40 w-[calc(100%-1rem)] text-sm"
        placeholder="What should this thread accomplish?"
        onChange={(event) => props.onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (canSave && !state.saving) props.onSave();
          }
        }}
      />
      {state.error !== null || draftError !== null ? (
        <p role="alert" className="px-3 pb-1.5 text-xs text-destructive">
          {state.error ?? draftError}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <span className="min-w-0 flex-1 truncate text-xs text-secondary-label" aria-live="polite">
          {state.draft.length >= GOAL_COUNTER_THRESHOLD
            ? `${state.draft.length}/${THREAD_GOAL_MAX_CHARS}`
            : ""}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {state.savedGoal !== null ? (
            <Button variant="ghost-muted" size="sm" disabled={state.saving} onClick={props.onClear}>
              Clear
            </Button>
          ) : null}
          <Button size="sm" disabled={!canSave} onClick={props.onSave}>
            {state.saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
});
