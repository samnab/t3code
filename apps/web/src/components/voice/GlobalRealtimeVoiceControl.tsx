import { useAtomValue } from "@effect/atom-react";
import { AudioLinesIcon, MicIcon, MicOffIcon } from "lucide-react";
import type { VoiceSnapshot } from "@t3tools/client-runtime/realtime-voice";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { useRealtimeVoice } from "./RealtimeVoiceProvider";

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

export function GlobalRealtimeVoiceControl() {
  const { snapshot, pause, resume, end, cancelResume, setKeywords, returnToOwner } =
    useRealtimeVoice();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  if (snapshot.mode === "off") return null;
  const shortcut = (command: "voice.togglePause" | "voice.micOff") => {
    const label = shortcutLabelForCommand(keybindings, command, { context: { voiceActive: true } });
    return label === null ? null : <Kbd>{label}</Kbd>;
  };
  const owner = snapshot.owner;
  const live = snapshot.mode === "transmitting" || snapshot.mode === "connecting";
  const armed = snapshot.listening === "armed";
  const listening = snapshot.listening === "listening" || armed;
  return (
    <div
      className="pointer-events-none fixed inset-x-3 top-3 z-100 flex justify-center"
      role="region"
      aria-label="Voice conversation"
    >
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-3 rounded-xl bg-popover px-3 py-2 text-popover-foreground shadow-lg [-webkit-app-region:no-drag]">
        {snapshot.mode === "transmitting" ? (
          <AudioLinesIcon className="size-4 shrink-0" aria-hidden="true" />
        ) : listening ? (
          <MicIcon className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <MicOffIcon className="size-4 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1 text-sm" role="status">
          <p>{statusText(snapshot)}</p>
          <p className="truncate text-muted-foreground">
            {owner.threadTitle} · {owner.environmentLabel}
          </p>
          {live && (
            <p className="text-xs text-muted-foreground">
              {snapshot.expiresAt === null
                ? "Calls last up to 4 hours"
                : `Ends by ${new Date(snapshot.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            </p>
          )}
          {snapshot.reason && (
            <p className="max-w-md text-xs text-muted-foreground">{snapshot.reason}</p>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => returnToOwner(owner)}>
          Return
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-pressed={snapshot.keywords}
          // A call's keyword tap is fixed when it starts; change keywords while paused.
          disabled={snapshot.mode !== "paused"}
          title={
            snapshot.mode === "paused" ? KEYWORDS_HINT : `${KEYWORDS_HINT} Change while paused.`
          }
          onClick={() => setKeywords(!snapshot.keywords)}
        >
          {snapshot.keywords ? "Keywords on" : "Keywords off"}
        </Button>
        {armed ? (
          <>
            <Button
              size="sm"
              variant="default"
              disabled={snapshot.replacementBlocked}
              // Only a real click in this window confirms; a scripted click is ignored.
              onClick={(event) => event.isTrusted && resume()}
            >
              Confirm
              {shortcut("voice.togglePause")}
            </Button>
            <Button size="sm" variant="outline" onClick={cancelResume}>
              Cancel
            </Button>
          </>
        ) : snapshot.mode === "paused" || snapshot.mode === "pausing" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={snapshot.mode === "pausing" || snapshot.replacementBlocked}
            onClick={(event) => event.isTrusted && resume()}
          >
            Resume
            {shortcut("voice.togglePause")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={!live} onClick={pause}>
            Pause
            {shortcut("voice.togglePause")}
          </Button>
        )}
        <Button size="sm" variant="destructive-outline" onClick={end}>
          {snapshot.mode === "connecting" ? "Cancel" : "Mic off"}
          {shortcut("voice.micOff")}
        </Button>
      </div>
    </div>
  );
}
