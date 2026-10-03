import type { ThreadGoalLoop } from "@t3tools/contracts";
import type { ThreadGoalLoopAction } from "@t3tools/client-runtime/state/thread-goal-editor";
import { isThreadGoalLoopActionAvailable } from "@t3tools/client-runtime/state/thread-goal-editor";
import { PauseIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { describeGoalLoop } from "./threadGoalLoopPresentation";

interface ThreadGoalEditorProps {
  readonly draft: string;
  readonly savedGoal: string | null;
  readonly goalLoop: ThreadGoalLoop | null;
  readonly saving: boolean;
  readonly error: string | null;
  readonly validationError: string | null;
  readonly canSave: boolean;
  readonly onDraftChange: (draft: string) => void;
  readonly onSave: () => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
  readonly onLoopAction: (action: ThreadGoalLoopAction) => void;
}

/** Dumb editor for a durable thread goal and its provider-neutral continuation loop. */
export function ThreadGoalEditor(props: ThreadGoalEditorProps) {
  const message = props.error ?? props.validationError;
  const loop = props.goalLoop;
  const loopPresentation = describeGoalLoop(loop);
  return (
    <div
      className="rounded-xl border border-border bg-popover p-3 shadow-sm"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-sm text-foreground">Thread goal</div>
          {loop ? (
            <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
              <span
                aria-hidden
                className={`size-1.5 rounded-full ${loop.state === "running" ? "bg-success" : "bg-muted-foreground"}`}
              />
              {loopPresentation?.label} · {loop.iterations}/{loop.maxIterations}
            </div>
          ) : null}
        </div>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Close goal editor"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <Textarea
        size="sm"
        aria-label="Thread goal"
        placeholder="What should this thread accomplish?"
        value={props.draft}
        disabled={props.saving}
        onChange={(event) => props.onDraftChange(event.currentTarget.value)}
      />
      {message ? <p className="mt-1.5 text-destructive text-xs">{message}</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {loop && isThreadGoalLoopActionAvailable(loop, "pause") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={props.saving}
              onClick={() => props.onLoopAction("pause")}
            >
              <PauseIcon /> Pause
            </Button>
          ) : null}
          {loop && isThreadGoalLoopActionAvailable(loop, "resume") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={props.saving}
              onClick={() => props.onLoopAction("resume")}
            >
              <PlayIcon /> Resume
            </Button>
          ) : null}
          {loop && isThreadGoalLoopActionAvailable(loop, "continue") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={props.saving}
              onClick={() => props.onLoopAction("continue")}
            >
              <PlayIcon /> Continue
            </Button>
          ) : null}
          {loop && isThreadGoalLoopActionAvailable(loop, "reset") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={props.saving}
              onClick={() => props.onLoopAction("reset")}
            >
              <RotateCcwIcon /> Reset
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {props.savedGoal ? (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={props.saving}
              onClick={props.onClear}
            >
              Clear
            </Button>
          ) : null}
          <Button size="xs" disabled={!props.canSave} onClick={props.onSave}>
            {props.saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
