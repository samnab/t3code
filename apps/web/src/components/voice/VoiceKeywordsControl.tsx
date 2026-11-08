import { EarIcon, EarOffIcon } from "lucide-react";
import { useId, useState } from "react";
import type { VoiceSnapshot } from "@t3tools/client-runtime/realtime-voice";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Mirror CONFIRM_MIN_GAP_MS and RESUME_ARM_MS in client-runtime realtime-voice/privacyController.ts.
const CONFIRM_AFTER_S = 3;
const CONFIRM_WITHIN_S = 10;

/** The spoken commands. Phrases must match KEYWORDS in public/voice/kws/worker.src.js, which are
 * pretokenized and so cannot be imported. */
const VOICE_KEYWORDS = [
  { phrase: "pause voice", does: "Pauses. Nothing is sent." },
  { phrase: "resume voice", does: "Asks to resume. Voice stays paused until you confirm." },
  {
    phrase: "confirm unpause",
    does: `Resumes when said ${CONFIRM_AFTER_S}–${CONFIRM_WITHIN_S} seconds after “resume voice”. Pressing Confirm also works. Saying “pause voice” or pressing Cancel keeps it paused.`,
  },
] as const;

const UNAVAILABLE =
  "Keywords unavailable: local listening failed on this device. They try again when the call resumes.";

type Call = Exclude<VoiceSnapshot, { mode: "off" }>;

function KeywordsSummary({
  snapshot,
  status,
}: {
  readonly snapshot: Call;
  readonly status: string;
}) {
  if (snapshot.listening === "unavailable") return <p>{UNAVAILABLE}</p>;
  if (!snapshot.keywords)
    return (
      <p className="text-muted-foreground">
        Keywords are off. Turn them on to pause and resume by voice. Listening stays on this device.
      </p>
    );
  return (
    <>
      {snapshot.mode === "paused" && <p className="font-medium">{status}</p>}
      <dl className="flex flex-col gap-1.5">
        {VOICE_KEYWORDS.map(({ phrase, does }) => (
          <div key={phrase}>
            <dt className="font-medium">“{phrase}”</dt>
            <dd className="text-muted-foreground">{does}</dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground">
        Listening stays on this device. Sentences containing “pause voice” can pause by mistake.
      </p>
    </>
  );
}

/**
 * The Keywords control in both voice layouts. Hover or focus previews the spoken commands; a click
 * opens a panel with the on/off switch. Opening it never changes keywords.
 */
export function VoiceKeywordsControl({
  snapshot,
  status,
  labels,
  setKeywords,
}: {
  readonly snapshot: Call;
  readonly status: string;
  readonly labels: string;
  readonly setKeywords: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const switchId = useId();
  const unavailable = snapshot.listening === "unavailable";
  const state = unavailable ? "unavailable" : snapshot.keywords ? "on" : "off";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={<Button size="sm" variant="ghost" aria-label={`Keywords: ${state}`} />}
            />
          }
        >
          {state === "on" ? <EarIcon aria-hidden="true" /> : <EarOffIcon aria-hidden="true" />}
          <span className={labels}>Keywords {state}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom" className="max-w-80">
          <div className="flex flex-col gap-1.5 p-1">
            {state === "on" && <p className="font-medium">Keywords are on</p>}
            <KeywordsSummary snapshot={snapshot} status={status} />
            <p className="text-muted-foreground">
              Click to {snapshot.keywords ? "change" : "turn on"}.
            </p>
          </div>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" width="md" padding="compact" touchBackdrop>
        <div className="flex flex-col gap-2 text-sm" role="group" aria-label="Voice keywords">
          <div className="flex min-h-11 items-center justify-between gap-3">
            <label htmlFor={switchId} className="font-medium">
              Keywords
            </label>
            <Switch id={switchId} checked={snapshot.keywords} onCheckedChange={setKeywords} />
          </div>
          <KeywordsSummary snapshot={snapshot} status={status} />
        </div>
      </PopoverPopup>
    </Popover>
  );
}
