import type { VoiceSnapshot } from "@t3tools/client-runtime/realtime-voice";

export type VoiceShortcutCommand = "voice.togglePause" | "voice.micOff";

export const isVoiceShortcutCommand = (value: string | null): value is VoiceShortcutCommand =>
  value === "voice.togglePause" || value === "voice.micOff";

/**
 * What a voice shortcut does in the current mode. Only a trusted key press in this document may
 * resume. A chord forwarded from a Browser-panel guest or replayed from a rendered page may come
 * from an agent or a page script, so it can only pause or turn the microphone off.
 */
export function voiceShortcutAction(
  mode: VoiceSnapshot["mode"],
  command: VoiceShortcutCommand,
  mayResume: boolean,
): "pause" | "resume" | "end" | null {
  if (mode === "off") return null;
  if (command === "voice.micOff") return "end";
  if (mode !== "paused") return "pause";
  return mayResume ? "resume" : null;
}
