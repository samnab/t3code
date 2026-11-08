import { useAtomValue } from "@effect/atom-react";
import {
  CheckIcon,
  ChevronDownIcon,
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
import type { ScopedThreadRef } from "@t3tools/contracts";
import type {
  VoiceLevels,
  VoiceOwner,
  VoiceSnapshot,
} from "@t3tools/client-runtime/realtime-voice";
import { useThreadRouteRef } from "../../hooks/useThreadRouteTarget";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { METER_STEPS, meterStep, speakingPhrase } from "../../voice/voiceLevels";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useRealtimeVoice, useRealtimeVoiceActive } from "./RealtimeVoiceProvider";
import { VoiceAudioDevices } from "./VoiceAudioDevices";

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
const KEYWORDS_HOW =
  "Say “pause voice” to pause. To resume, say “resume voice”, then say “confirm unpause” within 10 seconds, or press Confirm. Listening stays on this device. Sentences containing “pause voice” can pause by mistake.";

function keywordsHint(snapshot: Exclude<VoiceSnapshot, { mode: "off" }>): string {
  if (snapshot.listening === "unavailable")
    return "Keywords unavailable: local listening failed on this device. They try again when the call resumes.";
  return snapshot.keywords
    ? `Keywords on. ${KEYWORDS_HOW} Click to turn off.`
    : `Keywords off. Click to turn on. ${KEYWORDS_HOW}`;
}

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

/** Whether `ref` (the thread on screen) is the call's owner. The one owner test for both layouts. */
function isVoiceOwner(owner: VoiceOwner, ref: ScopedThreadRef | null): boolean {
  return ref?.environmentId === owner.environmentId && ref.threadId === owner.threadId;
}

/**
 * The live call as a header pill. Click opens the full controls, plus Return away from the owner.
 * Mount it in every header a call can outlive; it renders nothing without a call or outside the
 * voice provider. Pass `ownerHasComposer` only where the owner's composer, and so its strip, is
 * mounted: the pill then steps aside on the owner thread.
 */
export function GlobalRealtimeVoiceControl({
  className,
  ownerHasComposer = false,
}: {
  readonly className?: string;
  readonly ownerHasComposer?: boolean;
}) {
  return useRealtimeVoiceActive() ? (
    <VoicePill className={className} ownerHasComposer={ownerHasComposer} />
  ) : null;
}

/**
 * The live call as a strip attached above the owner thread's composer. `threadRef` is the
 * composer's thread; it renders nothing for any other thread. Both layouts only read the shared
 * voice snapshot, so switching between them never touches the call.
 */
export function RealtimeVoiceComposerStrip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  return useRealtimeVoiceActive() ? <VoiceStrip threadRef={threadRef} /> : null;
}

type VoiceCall = NonNullable<ReturnType<typeof useVoiceCall>>;

function useVoiceCall() {
  const voice = useRealtimeVoice();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { snapshot } = voice;
  if (snapshot.mode === "off") return null;
  const hint = (action: string, command: "voice.togglePause" | "voice.micOff") => {
    const label = shortcutLabelForCommand(keybindings, command, { context: { voiceActive: true } });
    return label === null ? action : `${action} (${label})`;
  };
  const owner = snapshot.owner;
  const live = snapshot.mode === "transmitting" || snapshot.mode === "connecting";
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
  return { ...voice, snapshot, hint, live, details, status: statusText(snapshot) };
}

// The pill drops its label, and the strip its button labels, below these container widths. The
// popover always has room for labels.
const STRIP_LABELS = "@max-[44rem]:sr-only";

// Short state for the closed pill, in the status text's own words.
function pillState(snapshot: VoiceCall["snapshot"]): string {
  if (snapshot.mode === "transmitting") return snapshot.micMuted ? "Muted" : "Live";
  if (snapshot.mode === "connecting") return "Connecting";
  if (snapshot.mode === "ending") return "Ending";
  return "Paused";
}

function VoiceStrip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const call = useVoiceCall();
  const region = useRef<HTMLDivElement>(null);
  const shown = call !== null && isVoiceOwner(call.snapshot.owner, threadRef);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Return unmounts the focused pill; land focus in the owner's composer instead of <body>
  useEffect(() => {
    if (!shown || document.activeElement !== document.body) return;
    region.current
      ?.closest("[data-chat-composer-form]")
      ?.querySelector<HTMLElement>('[data-testid="composer-editor"]')
      ?.focus();
  }, [shown]);
  if (!shown) return null;
  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root variant={call.snapshot.reason ? "warning" : "default"}>
        <div
          ref={region}
          className="flex min-w-0 items-center gap-1 ps-1.5"
          role="region"
          aria-label="Voice conversation"
        >
          <Tooltip>
            <TooltipTrigger
              render={<div className="flex min-w-0 flex-1 items-center gap-1.5 pe-1" />}
            >
              <VoiceStatusIcon call={call} />
              <span className="min-w-0 truncate text-sm @max-[24rem]:sr-only" role="status">
                {call.status}
                <span className="sr-only">
                  {" "}
                  · {call.details.map((detail) => detail.line).join(" · ")}
                </span>
              </span>
              {call.snapshot.reason && (
                <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              <VoiceDetails call={call} />
            </TooltipPopup>
          </Tooltip>
          <VoiceAudioDevices labels={STRIP_LABELS} />
          <VoiceActions call={call} labels={STRIP_LABELS} />
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function VoicePill({
  className,
  ownerHasComposer,
}: {
  readonly className: string | undefined;
  readonly ownerHasComposer: boolean;
}) {
  const call = useVoiceCall();
  const route = useThreadRouteRef();
  const panel = useRef<HTMLDivElement>(null);
  if (call === null) return null;
  const atOwner = isVoiceOwner(call.snapshot.owner, route);
  if (atOwner && ownerHasComposer) return null;
  const { snapshot, status } = call;
  // Away from the owner, the pill names it.
  const label = atOwner
    ? pillState(snapshot)
    : `${pillState(snapshot)} in ${snapshot.owner.threadTitle}`;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center overflow-hidden rounded-full border border-border/60 p-px has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring [-webkit-app-region:no-drag]",
        className,
      )}
      role="region"
      aria-label="Voice conversation"
    >
      <Popover>
        <PopoverTrigger
          render={<Button size="sm" variant="ghost" />}
          aria-label={`Voice controls · ${label}`}
        >
          <VoiceStatusIcon call={call} />
          <span className="min-w-0 max-w-48 truncate @max-[56rem]:hidden">{label}</span>
          {snapshot.reason && <CircleAlertIcon className="text-warning" aria-hidden="true" />}
          <ChevronDownIcon aria-hidden="true" />
        </PopoverTrigger>
        {/* Focus lands on the panel, not Return: a focused button's tooltip would take the first Escape. */}
        <PopoverPopup
          side="bottom"
          align="end"
          width="md"
          padding="compact"
          touchBackdrop
          initialFocus={panel}
        >
          <div
            ref={panel}
            tabIndex={-1}
            className="flex flex-col gap-3 outline-none"
            role="group"
            aria-label="Voice controls"
          >
            <VoiceDetails call={call} />
            {!atOwner && (
              <div>
                <ReturnButton call={call} />
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              <VoiceAudioDevices labels="" />
              <VoiceActions call={call} labels="" />
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      <span className="sr-only" role="status">
        {status}
      </span>
      <VoicePrimaryAction call={call} labels="sr-only" />
    </div>
  );
}

function VoiceDetails({ call }: { readonly call: VoiceCall }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p className="font-medium">{call.status}</p>
      {call.details.map(({ key, line }) => (
        <p key={key} className="text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}

function VoiceStatusIcon({ call }: { readonly call: VoiceCall }) {
  const { snapshot } = call;
  if (snapshot.mode === "transmitting" && !snapshot.micMuted)
    return <VoiceLevelMeter levels={call.levels} />;
  const listening = snapshot.listening === "listening" || snapshot.listening === "armed";
  const StatusIcon = listening ? MicIcon : MicOffIcon;
  return <StatusIcon className="size-4 shrink-0" aria-hidden="true" />;
}

function ReturnButton({ call }: { readonly call: VoiceCall }) {
  const { owner } = call.snapshot;
  return (
    <VoiceButton
      icon={CornerUpLeftIcon}
      label="Return"
      hint={`Return to ${owner.threadTitle}`}
      variant="ghost"
      labels=""
      onClick={() => call.returnToOwner(owner)}
    />
  );
}

/** Keywords, Mute, the pause group and Stop, in the same order and copy in both layouts. */
function VoiceActions({ call, labels }: { readonly call: VoiceCall; readonly labels: string }) {
  const { snapshot, hint } = call;
  const ending = snapshot.mode === "ending";
  const unavailable = snapshot.listening === "unavailable";
  return (
    <>
      {/* Ending, nothing but the closing call is left to act on. */}
      {!ending && (
        <>
          <VoiceButton
            icon={snapshot.keywords && !unavailable ? EarIcon : EarOffIcon}
            label={
              unavailable
                ? "Keywords unavailable"
                : snapshot.keywords
                  ? "Keywords on"
                  : "Keywords off"
            }
            hint={keywordsHint(snapshot)}
            variant="ghost"
            labels={labels}
            aria-label={unavailable ? "Keywords unavailable" : "Keywords"}
            aria-pressed={snapshot.keywords && !unavailable}
            // aria-disabled, not disabled: a disabled button takes no hover or focus, so its
            // tooltip could never say why.
            aria-disabled={unavailable || undefined}
            onClick={() => !unavailable && call.setKeywords(!snapshot.keywords)}
          />
          <MuteButton call={call} labels={labels} />
          <PauseGroup call={call} labels={labels} />
        </>
      )}
      <VoiceButton
        icon={PhoneOffIcon}
        label={snapshot.mode === "connecting" ? "Cancel" : "Stop session"}
        hint={hint(snapshot.mode === "connecting" ? "Cancel call" : "Stop session", "voice.micOff")}
        variant="destructive-outline"
        labels={labels}
        disabled={ending}
        onClick={call.end}
      />
    </>
  );
}

// The pill's one-click action: whatever the pause group offers while paused, none while ending,
// else Mute.
function VoicePrimaryAction({
  call,
  labels,
}: {
  readonly call: VoiceCall;
  readonly labels: string;
}) {
  const { mode } = call.snapshot;
  if (mode === "ending") return null;
  return mode === "paused" || mode === "pausing" ? (
    <PauseGroup call={call} labels={labels} />
  ) : (
    <MuteButton call={call} labels={labels} />
  );
}

function MuteButton({ call, labels }: { readonly call: VoiceCall; readonly labels: string }) {
  const { snapshot } = call;
  return (
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
      labels={labels}
      aria-label={snapshot.micMuted ? "Unmute microphone" : "Mute microphone"}
      aria-pressed={snapshot.micMuted}
      disabled={snapshot.mode !== "transmitting"}
      // The armed row is the widest; an idle disabled Mute is the first thing to drop there.
      className={
        snapshot.mode === "paused" && !snapshot.micMuted ? "@max-[28rem]:hidden" : undefined
      }
      onClick={call.toggleMute}
    />
  );
}

function PauseGroup({ call, labels }: { readonly call: VoiceCall; readonly labels: string }) {
  const { snapshot, hint } = call;
  if (snapshot.listening === "armed")
    return (
      <>
        <VoiceButton
          icon={CheckIcon}
          label="Confirm"
          hint={hint("Confirm resume", "voice.togglePause")}
          variant="default"
          labels={labels}
          disabled={snapshot.replacementBlocked}
          // Only a real click in this window confirms; a scripted click is ignored.
          onClick={(event) => event.isTrusted && call.resume()}
        />
        <VoiceButton
          icon={XIcon}
          label="Cancel"
          hint="Stay paused"
          variant="outline"
          labels={labels}
          onClick={call.cancelResume}
        />
      </>
    );
  if (snapshot.mode === "paused" || snapshot.mode === "pausing")
    return (
      <VoiceButton
        icon={PlayIcon}
        label="Resume"
        hint={hint("Resume", "voice.togglePause")}
        variant="outline"
        labels={labels}
        disabled={snapshot.mode === "pausing" || snapshot.replacementBlocked}
        onClick={(event) => event.isTrusted && call.resume()}
      />
    );
  return (
    <VoiceButton
      icon={PauseIcon}
      label="Pause"
      hint={hint("Pause conversation", "voice.togglePause")}
      aria-label="Pause conversation"
      variant="outline"
      labels={labels}
      disabled={!call.live}
      onClick={call.pause}
    />
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

// The label stays in the accessible name when `labels` drops it visually for space.
function VoiceButton({
  icon: Icon,
  label,
  hint,
  labels,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly hint: string;
  readonly labels: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="sm" {...props} />}>
        <Icon aria-hidden="true" />
        <span className={labels}>{label}</span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">{hint}</TooltipPopup>
    </Tooltip>
  );
}
