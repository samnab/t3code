import { use } from "react";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { MessageCopyButton } from "./MessageCopyButton";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Render provider speech as selectable history without message or executable markdown actions. */
export function VoiceTranscriptTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { item, visibility } = row.projectedItem;
  if (item.type !== "realtime_voice") return null;
  const content = item.content;
  if (content.type === "bemItemPromoted") return null;
  const observed = (
    <Tooltip>
      <TooltipTrigger render={<span className="text-xs tabular-nums text-muted-foreground" />}>
        Observed {formatDayAwareTimestamp(row.createdAt, ctx.timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>
        {formatChatTimestampTooltip(row.createdAt, ctx.timestampFormat)}. Provider-completed
        history; earlier speech may be missing and source order has not been reconciled.
      </TooltipPopup>
    </Tooltip>
  );
  if (content.type !== "transcriptSegment") {
    return (
      <div
        className="flex flex-wrap items-center justify-center gap-2 py-1 text-xs text-muted-foreground"
        data-voice-session-id={item.realtimeSessionId}
      >
        <span>
          {content.type === "realtimeSessionStarted"
            ? "Voice conversation started"
            : content.outcome === "failed"
              ? "Voice conversation failed"
              : "Voice conversation ended"}
        </span>
        {observed}
      </div>
    );
  }
  return (
    <div
      className="min-w-0 space-y-1.5 px-1 py-0.5"
      data-v2-item-type="realtime_voice"
      data-voice-role={content.role}
      data-voice-capture-state={item.captureState}
      data-voice-session-id={item.realtimeSessionId}
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        {content.role === "user" ? "You" : "Codex"} · Voice transcript
        {visibility === "inherited" ? " · Inherited" : ""}
      </h3>
      <p
        className="whitespace-pre-wrap break-words text-base leading-relaxed"
        data-thread-find-text="true"
      >
        {content.text}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <MessageCopyButton text={content.text} label="Copy voice transcript" variant="ghost" />
        <span className="text-xs text-muted-foreground">Provider completed</span>
        {observed}
      </div>
    </div>
  );
}
