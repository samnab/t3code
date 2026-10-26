import {
  describeRealtimeVoiceCapture,
  type RealtimeVoiceCall,
} from "@t3tools/shared/orchestrationV2Timeline";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { MicIcon, TriangleAlertIcon } from "lucide-react";
import { use } from "react";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { MessageCopyButton } from "./MessageCopyButton";
import { TimelineRowCtx, type TimelineRow } from "./timelineRowContext";
import {
  MessageAuthorHeading,
  TimelineMessageMarker,
  TimelineRowTimestamp,
} from "./TimelineRowParts";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import {
  USER_MESSAGE_ACTIONS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_CLASS_NAME,
} from "./TimelineUserMessageRow";
import { cn } from "~/lib/utils";

/**
 * Spoken lines look like messages but stay history: plain text, copy only, no edit, revert,
 * fork, or markdown actions. The row that opens a call also carries the call divider. A request
 * promoted into a coding message shows as that message, so its row keeps only the divider.
 */
export function VoiceTranscriptTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "event" }>;
}) {
  const { item } = row.projectedItem;
  if (item.type !== "realtime_voice") return null;
  const divider = row.voiceCall ? <VoiceCallDivider call={row.voiceCall} /> : null;
  if (item.content.type !== "transcriptSegment" || row.voicePromotedToRowId !== undefined)
    return divider;
  return (
    <>
      {divider}
      <VoiceLine row={row} />
    </>
  );
}

function VoiceCallDivider({ call }: { call: RealtimeVoiceCall }) {
  const ctx = use(TimelineRowCtx);
  const detail = [
    formatDayAwareTimestamp(call.startedAt, ctx.timestampFormat),
    call.durationMs === null ? null : formatDuration(call.durationMs),
    call.failed ? "failed" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div>
      <TimelineSystemDivider
        label="Voice call"
        icon={MicIcon}
        detail={detail}
        tone={call.failed ? "danger" : "neutral"}
      />
      {call.historyWarning === null ? null : (
        <p
          role="note"
          className="flex items-center justify-center gap-1.5 text-center text-xs text-warning"
          data-voice-history-warning="true"
        >
          <TriangleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
          <span>
            <span className="font-medium">Voice history incomplete.</span> {call.historyWarning}
          </span>
        </p>
      )}
    </div>
  );
}

function VoiceLine({ row }: { row: Extract<TimelineRow, { kind: "event" }> }) {
  const ctx = use(TimelineRowCtx);
  const { item, visibility } = row.projectedItem;
  if (item.type !== "realtime_voice" || item.content.type !== "transcriptSegment") return null;
  const { role, text } = item.content;
  const capture = describeRealtimeVoiceCapture(item);
  // Partial text must say so without hovering.
  const state =
    item.captureState === "interrupted"
      ? "interrupted"
      : item.captureState === "incomplete"
        ? "incomplete"
        : null;
  const marker = (
    <TimelineMessageMarker
      icon={MicIcon}
      label={state === null ? "Voice" : `Voice · ${state}`}
      ariaLabel={`Spoken in a voice call${state === null ? "" : `, ${state}`}`}
      align={role === "user" ? "end" : "start"}
      dataAttributes={{ "data-voice-capture-state": item.captureState }}
      tooltip={
        <>
          {capture.status}. {capture.timeLabel}{" "}
          {formatChatTimestampTooltip(row.createdAt, ctx.timestampFormat)}.
          {visibility === "inherited" ? " Inherited from the source thread." : ""} {capture.detail}
        </>
      }
    />
  );
  const actions = (
    <>
      <TimelineRowTimestamp
        createdAt={row.createdAt}
        timestampFormat={ctx.timestampFormat}
        alwaysVisible
      />
      <MessageCopyButton text={text} label="Copy voice transcript" variant="ghost" />
    </>
  );
  const dataAttributes = {
    "data-v2-item-type": "realtime_voice",
    "data-voice-role": role,
    "data-voice-session-id": item.realtimeSessionId,
  };

  if (role === "user") {
    return (
      <div className="group flex flex-col items-end gap-1" {...dataAttributes}>
        {marker}
        <div className={cn(USER_MESSAGE_BUBBLE_CLASS_NAME, "bg-message p-3")}>
          <MessageAuthorHeading>You</MessageAuthorHeading>
          <p
            className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
            data-thread-find-text="true"
          >
            {text}
          </p>
        </div>
        <div className={USER_MESSAGE_ACTIONS_CLASS_NAME}>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="group relative min-w-0 space-y-1.5 px-1 py-0.5" {...dataAttributes}>
      <MessageAuthorHeading>T3 Code</MessageAuthorHeading>
      {marker}
      <p
        className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/[calc(80%+var(--appearance-contrast-boost)/5)]"
        data-thread-find-text="true"
      >
        {text}
      </p>
      <div className="flex items-center gap-2 text-xs tabular-nums opacity-0 transition-opacity duration-200 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover:opacity-100">
        {actions}
      </div>
    </div>
  );
}
