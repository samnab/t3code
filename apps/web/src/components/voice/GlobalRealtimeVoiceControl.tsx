import { AudioLinesIcon, MicOffIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useRealtimeVoice } from "./RealtimeVoiceProvider";

export function GlobalRealtimeVoiceControl() {
  const { snapshot, end, returnToOwner } = useRealtimeVoice();
  if (snapshot.mode === "off") return null;
  const owner = snapshot.owner;
  const status =
    snapshot.mode === "transmitting"
      ? "Microphone audio sent to Codex"
      : snapshot.mode === "connecting"
        ? "Connecting · microphone not sending"
        : snapshot.mode === "ending"
          ? "Microphone off · ending call"
          : "Microphone off";
  return (
    <div
      className="pointer-events-none fixed inset-x-3 top-3 z-100 flex justify-center"
      role="region"
      aria-label="Voice conversation"
    >
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-3 rounded-xl bg-popover px-3 py-2 text-popover-foreground shadow-lg [-webkit-app-region:no-drag]">
        {snapshot.mode === "transmitting" ? (
          <AudioLinesIcon className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <MicOffIcon className="size-4 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1 text-sm" role="status">
          <p>{status}</p>
          {owner && (
            <p className="truncate text-muted-foreground">
              {owner.threadTitle} · {owner.environmentLabel}
            </p>
          )}
          {snapshot.reason && (
            <p className="max-w-md text-xs text-muted-foreground">{snapshot.reason}</p>
          )}
        </div>
        {owner && (
          <Button size="sm" variant="ghost" onClick={() => returnToOwner(owner)}>
            Return
          </Button>
        )}
        {owner && (
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={snapshot.mode === "ending"}
            onClick={end}
          >
            {snapshot.mode === "connecting" ? "Cancel" : "End"}
          </Button>
        )}
      </div>
    </div>
  );
}
