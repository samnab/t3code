import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AudioLinesIcon, MicIcon } from "lucide-react";
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
  const { snapshot, start, move, end, returnToOwner } = useRealtimeVoice();
  const owner = snapshot.owner;
  const isOwner = owner?.environmentId === environmentId && owner.threadId === threadId;
  const tooltip =
    owner !== null
      ? isOwner
        ? "End voice in this conversation"
        : `Voice in ${owner.threadTitle} · Return to conversation`
      : snapshot.replacementBlocked
        ? [snapshot.reason, VOICE_REPLACEMENT_GATE].filter(Boolean).join(" ")
        : (snapshot.reason ?? "Talk with Codex by voice");
  const activate = () => {
    if (owner !== null) {
      if (isOwner) end();
      else returnToOwner(owner);
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
              aria-pressed={isOwner && snapshot.mode !== "ending"}
              type="button"
              disabled={
                (isOwner && snapshot.mode === "ending") ||
                (owner === null && snapshot.replacementBlocked)
              }
              onClick={activate}
              aria-label={tooltip}
            />
          }
        >
          <ComposerControlIcon
            icon={owner !== null ? AudioLinesIcon : MicIcon}
            size={size}
            opticalSize={size === "xs" ? "default" : "large"}
          />
          <span data-composer-control-label className="sr-only sm:not-sr-only">
            {owner !== null && !isOwner
              ? "Voice elsewhere"
              : snapshot.mode === "connecting"
                ? "Cancel voice"
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
                disabled={snapshot.mode === "ending" || snapshot.replacementBlocked}
                onClick={() => move(environmentId, threadId)}
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
