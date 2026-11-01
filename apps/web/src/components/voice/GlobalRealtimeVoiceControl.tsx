import { useAtomValue } from "@effect/atom-react";
import {
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
import { useEffect, useRef, type ComponentProps } from "react";
import type { VoiceLevels, VoiceSnapshot } from "@t3tools/client-runtime/realtime-voice";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { METER_STEPS, meterStep, speakingPhrase } from "../../voice/voiceLevels";
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
  armed: "Resume? Say “confirm unpause” or press Confirm",
  unavailable: "Keywords unavailable · press Resume",
} as const;
const KEYWORDS_HINT =
  "Say “T3 privacy pause” to pause. To resume, say “T3 resume conversation”, then say “confirm unpause” within 10 seconds, or press Confirm. Listening stays on this device. Similar phrases such as “T3 privacy policy” can pause by mistake.";

// Muting shuts only the call's gate: the track stays enabled, so the OS indicator stays on and,
// with keywords on, the detector still hears a spoken pause.
function statusText(snapshot: Exclude<VoiceSnapshot, { mode: "off" }>): string {
  if (snapshot.mode === "paused") return LISTENING_STATUS[snapshot.listening];
  if (snapshot.mode === "transmitting" && snapshot.micMuted)
    return snapshot.keywords
      ? "Muted · not sending · mic stays on for keywords"
      : "Muted · not sending";
  return STATUS[snapshot.mode];
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
  const {
    snapshot,
    pause,
    resume,
    end,
    cancelResume,
    toggleMute,
    levels,
    setKeywords,
    returnToOwner,
  } = useRealtimeVoice();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const route = useThreadRouteRef();
  if (snapshot.mode === "off") return null;
  const hint = (action: string, command: "voice.togglePause" | "voice.micOff") => {
    const label = shortcutLabelForCommand(keybindings, command, { context: { voiceActive: true } });
    return label === null ? action : `${action} (${label})`;
  };
  const owner = snapshot.owner;
  const atOwner = route?.environmentId === owner.environmentId && route.threadId === owner.threadId;
  const live = snapshot.mode === "transmitting" || snapshot.mode === "connecting";
  const armed = snapshot.listening === "armed";
  const listening = snapshot.listening === "listening" || armed;
  const status = statusText(snapshot);
  // Keyed by role: two lines can carry the same text.
  const details = [
    { key: "reason", line: snapshot.reason },
    { key: "owner", line: `${owner.threadTitle} · ${owner.environmentLabel}` },
    {
      key: "expiry",
      line: live
        ? snapshot.expiresAt === null
          ? "Calls last up to 4 hours"
          : `Ends by ${new Date(snapshot.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : null,
    },
  ].filter((detail) => detail.line !== null);
  const StatusIcon = listening ? MicIcon : MicOffIcon;
  return (
    <div
      className={cn("flex min-w-0 items-center gap-1 [-webkit-app-region:no-drag]", className)}
      role="region"
      aria-label="Voice conversation"
    >
      <Tooltip>
        <TooltipTrigger render={<div className="flex min-w-0 items-center gap-1.5 pe-1" />}>
          {snapshot.mode === "transmitting" && !snapshot.micMuted ? (
            <VoiceLevelMeter levels={levels} />
          ) : (
            <StatusIcon className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 max-w-56 truncate text-sm @max-[28rem]:sr-only" role="status">
            {status}
            <span className="sr-only"> · {details.map((detail) => detail.line).join(" · ")}</span>
          </span>
          {snapshot.reason && (
            <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          <p>{status}</p>
          {details.map(({ key, line }) => (
            <p key={key} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </TooltipPopup>
      </Tooltip>
      {!atOwner && (
        <VoiceButton
          icon={CornerUpLeftIcon}
          label="Return"
          hint={`Return to ${owner.threadTitle}`}
          variant="ghost"
          onClick={() => returnToOwner(owner)}
        />
      )}
      <VoiceButton
        icon={snapshot.keywords ? EarIcon : EarOffIcon}
        label={snapshot.keywords ? "Keywords on" : "Keywords off"}
        hint={snapshot.mode === "paused" ? KEYWORDS_HINT : `${KEYWORDS_HINT} Change while paused.`}
        variant="ghost"
        aria-pressed={snapshot.keywords}
        // A call's keyword tap is fixed when it starts; change keywords while paused. Disabled, it
        // is the first to go when the header is too narrow for every icon.
        disabled={snapshot.mode !== "paused"}
        className={snapshot.mode === "paused" ? undefined : "@max-[28rem]:hidden"}
        onClick={() => setKeywords(!snapshot.keywords)}
      />
      <VoiceButton
        icon={snapshot.micMuted ? MicOffIcon : MicIcon}
        label={snapshot.micMuted ? "Unmute" : "Mute"}
        hint={
          snapshot.mode === "transmitting"
            ? snapshot.micMuted
              ? "Unmute microphone"
              : "Mute microphone · mic stays on · you still hear Codex"
            : snapshot.micMuted
              ? "Muted · stays muted when the call resumes"
              : "Mute while the call is live"
        }
        variant="ghost"
        aria-label={snapshot.micMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={snapshot.micMuted}
        disabled={snapshot.mode !== "transmitting"}
        // The armed row is the widest; an idle disabled Mute is the first thing to drop there.
        className={
          snapshot.mode === "paused" && !snapshot.micMuted ? "@max-[28rem]:hidden" : undefined
        }
        onClick={toggleMute}
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
          hint={hint("Pause conversation", "voice.togglePause")}
          aria-label="Pause conversation"
          variant="outline"
          disabled={!live}
          onClick={pause}
        />
      )}
      <VoiceButton
        icon={PhoneOffIcon}
        label={snapshot.mode === "connecting" ? "Cancel" : "Stop session"}
        hint={hint(snapshot.mode === "connecting" ? "Cancel call" : "Stop session", "voice.micOff")}
        variant="destructive-outline"
        onClick={end}
      />
    </div>
  );
}

const METER_INTERVAL_MS = 67;
const BARS = [
  { key: "low", shape: 0.6 },
  { key: "high", shape: 1 },
  { key: "tail", shape: 0.6 },
];

/**
 * You (foreground) and Codex (info) as two small bar groups. A ~15 Hz poll writes CSS variables
 * on the element only when a step changes, so silence writes nothing and nothing re-renders.
 * Mounted only while audio is sent; it stops polling when unmounted or the document is hidden.
 * Reduced motion swaps the bars for two dots that switch on and off.
 */
function VoiceLevelMeter({ levels }: { readonly levels: () => VoiceLevels }) {
  const meter = useRef<HTMLSpanElement>(null);
  const phrase = useRef<HTMLSpanElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls transport levels on a timer into this DOM node's styles while mounted
  useEffect(() => {
    const node = meter.current;
    if (node === null) return;
    let input = 0;
    let output = 0;
    let timer: number | undefined;
    const sample = () => {
      const level = levels();
      const nextInput = meterStep(level.input);
      const nextOutput = meterStep(level.output);
      if (nextInput === input && nextOutput === output) return;
      if (nextInput > 0 !== input > 0 || nextOutput > 0 !== output > 0) {
        node.dataset.input = nextInput > 0 ? "on" : "off";
        node.dataset.output = nextOutput > 0 ? "on" : "off";
        if (phrase.current) phrase.current.textContent = speakingPhrase(nextInput, nextOutput);
      }
      input = nextInput;
      output = nextOutput;
      node.style.setProperty("--voice-in", String(input / METER_STEPS));
      node.style.setProperty("--voice-out", String(output / METER_STEPS));
    };
    const sync = () => {
      window.clearInterval(timer);
      timer =
        document.visibilityState === "visible"
          ? window.setInterval(sample, METER_INTERVAL_MS)
          : undefined;
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [levels]);
  return (
    <>
      <span
        ref={meter}
        aria-hidden="true"
        data-input="off"
        data-output="off"
        className="group/meter flex h-4 shrink-0 items-center gap-0.75 [--voice-in:0] [--voice-out:0]"
      >
        {(["in", "out"] as const).map((role) => (
          <span
            key={role}
            className={cn(
              "flex h-full items-center gap-px",
              role === "in" ? "text-foreground" : "text-info",
            )}
          >
            {BARS.map(({ key, shape }) => (
              <span
                key={key}
                className="h-full w-0.5 rounded-full bg-current motion-reduce:hidden"
                style={{ scale: `1 calc(0.2 + var(--voice-${role}) * ${0.8 * shape})` }}
              />
            ))}
            <span
              className={cn(
                "hidden size-1.5 rounded-full bg-current opacity-30 motion-reduce:block",
                role === "in"
                  ? "group-data-[input=on]/meter:opacity-100"
                  : "group-data-[output=on]/meter:opacity-100",
              )}
            />
          </span>
        ))}
      </span>
      <span ref={phrase} className="sr-only" />
    </>
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
