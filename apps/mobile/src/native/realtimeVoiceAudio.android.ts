import type { RealtimeVoiceAudio } from "./realtimeVoiceAudio";

export type { RealtimeVoiceAudio, RealtimeVoiceAudioSnapshot } from "./realtimeVoiceAudio";

// Android has no gated native capture yet, so realtime voice is unsupported there.
// Defined here, not re-exported: "./realtimeVoiceAudio" resolves back to this file on Android.
export function getRealtimeVoiceAudio(): RealtimeVoiceAudio | null {
  return null;
}

export function realtimeVoiceOwnsAudio(): boolean {
  return false;
}
