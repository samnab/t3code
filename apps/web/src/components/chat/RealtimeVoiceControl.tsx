import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AudioLinesIcon, MicIcon, MicOffIcon } from "lucide-react";
import { VOICE_REPLACEMENT_GATE } from "@t3tools/client-runtime/realtime-voice";
import { useRealtimeVoice } from "../voice/RealtimeVoiceProvider";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

/** Routed controls observe the app owner; their unmount never releases media. */
export function RealtimeVoiceControl({
  environmentId,
  threadId,
  size,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  size: ComposerControlSize;
}) {
  const { snapshot, start, move, resume, end, returnToOwner } = useRealtimeVoice();
  const owner = snapshot.owner;
  const isOwner = owner?.environmentId === environmentId && owner.threadId === threadId;
  const paused = snapshot.mode === "paused" || snapshot.mode === "pausing";
  const settling = snapshot.mode === "ending" || snapshot.mode === "pausing";
  const tooltip =
    owner !== null
      ? isOwner
        ? paused
          ? snapshot.listening === "listening" || snapshot.listening === "armed"
            ? "Private: listening on this device; not sending. Resume voice in this conversation"
            : snapshot.listening === "unavailable"
              ? "Paused: local listening unavailable. Resume voice in this conversation"
              : "Voice paused · nothing is sent. Resume voice in this conversation"
          : "End voice in this conversation"
        : `${paused ? "Voice paused" : "Voice"} in ${owner.threadTitle} · Return to conversation`
      : snapshot.replacementBlocked
        ? [snapshot.reason, VOICE_REPLACEMENT_GATE].filter(Boolean).join(" ")
        : (snapshot.reason ?? "Talk with Codex by voice");
  const activate = (trusted: boolean) => {
    if (owner !== null) {
      if (!isOwner) returnToOwner(owner);
      else if (paused) {
        if (trusted) resume();
      } else end();
    } else start(environmentId, threadId);
  };
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              className="shrink-0 whitespace-nowrap"
              aria-pressed={isOwner && !settling && !paused}
              type="button"
              disabled={
                (isOwner && (settling || (paused && snapshot.replacementBlocked))) ||
                (owner === null && snapshot.replacementBlocked)
              }
              onClick={(event) => activate(event.isTrusted)}
              aria-label={tooltip}
            />
          }
        >
          <ComposerControlIcon
            icon={paused ? MicOffIcon : owner !== null ? AudioLinesIcon : MicIcon}
            size={size}
            opticalSize={size === "xs" ? "default" : "large"}
          />
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            {owner !== null && !isOwner
              ? "Voice elsewhere"
              : snapshot.mode === "connecting"
                ? "Cancel voice"
                : paused
                  ? "Resume voice"
                  : "Voice"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      {owner !== null && !isOwner && (
        <Tooltip>
          <TooltipTrigger
            render={
              <ComposerControl
                size={size}
                type="button"
                disabled={settling || snapshot.replacementBlocked}
                // Moving starts a microphone; only a real click may do that.
                onClick={(event) => event.isTrusted && move(environmentId, threadId)}
                aria-label={`End voice in ${owner.threadTitle} and talk in this conversation`}
              />
            }
          >
            <ComposerControlIcon
              icon={MicIcon}
              size={size}
              opticalSize={size === "xs" ? "default" : "large"}
            />
            <span data-composer-control-label>Talk here instead</span>
          </TooltipTrigger>
          <TooltipPopup side="top">End voice in {owner.threadTitle}, then start here</TooltipPopup>
        </Tooltip>
      )}
    </>
  );
}
