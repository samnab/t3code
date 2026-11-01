import { useAtomValue } from "@effect/atom-react";
import {
  AudioLinesIcon,
  CheckIcon,
  CircleAlertIcon,
  CornerUpLeftIcon,
  EarIcon,
  EarOffIcon,
  MicIcon,
  MicOffIcon,
  PauseIcon,
  PhoneOffIcon,
  PlayIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import type { VoiceSnapshot } from "@t3tools/client-runtime/realtime-voice";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useRealtimeVoice, useRealtimeVoiceActive } from "./RealtimeVoiceProvider";

const STATUS = {
  transmitting: "Microphone audio sent to Codex",
  connecting: "Connecting · microphone not sending",
  pausing: "Paused · microphone off · closing call",
  paused: "Paused · microphone off · nothing is sent",
  ending: "Microphone off · ending call",
} as const;
// While paused with keywords on, the microphone stays on (and so does the OS indicator) for the
// on-device detector only. The labels must never call that "microphone off".
const LISTENING_STATUS = {
  off: STATUS.paused,
  listening: "Private: listening on this device; not sending",
  armed: "Resume? Confirm to send audio",
  unavailable: "Paused: local listening unavailable",
} as const;
const KEYWORDS_HINT =
  "Say “T3 privacy pause” to pause, or “T3 resume conversation” to ask to resume. Listening stays on this device, and resuming always needs your confirmation. Similar phrases such as “T3 privacy policy” can pause by mistake.";

function statusText(snapshot: Exclude<VoiceSnapshot, { mode: "off" }>): string {
  return snapshot.mode === "paused" ? LISTENING_STATUS[snapshot.listening] : STATUS[snapshot.mode];
}

/**
 * The live call's status and controls, inline in a route's top bar. Mount it in every header a
 * call can outlive; it renders nothing without a call, or outside the voice provider. It collapses
 * against the nearest `@container`, normally the header row: button labels go below 56rem and the
 * status text below 28rem, leaving icon buttons named by tooltips and screen-reader text.
 */
export function GlobalRealtimeVoiceControl({ className }: { readonly className?: string }) {
  return useRealtimeVoiceActive() ? <VoiceControl className={className} /> : null;
}

function VoiceControl({ className }: { readonly className: string | undefined }) {
  const { snapshot, pause, resume, end, cancelResume, setKeywords, returnToOwner } =
    useRealtimeVoice();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (snapshot.mode === "off") return null;
  const hint = (action: string, command: "voice.togglePause" | "voice.micOff") => {
    const label = shortcutLabelForCommand(keybindings, command, { context: { voiceActive: true } });
    return label === null ? action : `${action} (${label})`;
  };
  const owner = snapshot.owner;
  const live = snapshot.mode === "transmitting" || snapshot.mode === "connecting";
  const armed = snapshot.listening === "armed";
  const listening = snapshot.listening === "listening" || armed;
  const status = statusText(snapshot);
  const details = [
    snapshot.reason,
    `${owner.threadTitle} · ${owner.environmentLabel}`,
    live
      ? snapshot.expiresAt === null
        ? "Calls last up to 4 hours"
        : `Ends by ${new Date(snapshot.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : null,
  ].filter((line) => line !== null);
  const StatusIcon =
    snapshot.mode === "transmitting" ? AudioLinesIcon : listening ? MicIcon : MicOffIcon;
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]", className)}
      role="region"
      aria-label="Voice conversation"
    >
      <Tooltip>
        <TooltipTrigger render={<div className="flex min-w-0 items-center gap-1.5 pe-1" />}>
          <StatusIcon className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 max-w-56 truncate text-sm @max-[28rem]:sr-only" role="status">
            {status}
            <span className="sr-only"> · {details.join(" · ")}</span>
          </span>
          {snapshot.reason && (
            <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          <p>{status}</p>
          {details.map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </TooltipPopup>
      </Tooltip>
      <VoiceButton
        icon={CornerUpLeftIcon}
        label="Return"
        hint={`Return to ${owner.threadTitle}`}
        variant="ghost"
        onClick={() => returnToOwner(owner)}
      />
      <VoiceButton
        icon={snapshot.keywords ? EarIcon : EarOffIcon}
        label={snapshot.keywords ? "Keywords on" : "Keywords off"}
        hint={snapshot.mode === "paused" ? KEYWORDS_HINT : `${KEYWORDS_HINT} Change while paused.`}
        variant="ghost"
        aria-pressed={snapshot.keywords}
        // A call's keyword tap is fixed when it starts; change keywords while paused.
        disabled={snapshot.mode !== "paused"}
        onClick={() => setKeywords(!snapshot.keywords)}
      />
      {armed ? (
        <>
          <VoiceButton
            icon={CheckIcon}
            label="Confirm"
            hint={hint("Confirm resume", "voice.togglePause")}
            variant="default"
            disabled={snapshot.replacementBlocked}
            // Only a real click in this window confirms; a scripted click is ignored.
            onClick={(event) => event.isTrusted && resume()}
          />
          <VoiceButton
            icon={XIcon}
            label="Cancel"
            hint="Stay paused"
            variant="outline"
            onClick={cancelResume}
          />
        </>
      ) : snapshot.mode === "paused" || snapshot.mode === "pausing" ? (
        <VoiceButton
          icon={PlayIcon}
          label="Resume"
          hint={hint("Resume", "voice.togglePause")}
          variant="outline"
          disabled={snapshot.mode === "pausing" || snapshot.replacementBlocked}
          onClick={(event) => event.isTrusted && resume()}
        />
      ) : (
        <VoiceButton
          icon={PauseIcon}
          label="Pause"
          hint={hint("Pause", "voice.togglePause")}
          variant="outline"
          disabled={!live}
          onClick={pause}
        />
      )}
      <VoiceButton
        icon={PhoneOffIcon}
        label={snapshot.mode === "connecting" ? "Cancel" : "Mic off"}
        hint={hint(snapshot.mode === "connecting" ? "Cancel call" : "Mic off", "voice.micOff")}
        variant="destructive-outline"
        onClick={end}
      />
    </div>
  );
}

// The label stays in the accessible name when it is visually dropped for space.
function VoiceButton({
  icon: Icon,
  label,
  hint,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly hint: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="sm" {...props} />}>
        <Icon aria-hidden="true" />
        <span className="@max-[56rem]:sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{hint}</TooltipPopup>
    </Tooltip>
  );
}
