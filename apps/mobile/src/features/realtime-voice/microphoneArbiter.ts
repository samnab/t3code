export type MicrophoneHolder = "dictation" | "realtime-voice";

/**
 * Exclusive JS claim on the microphone so dictation and realtime voice never capture together.
 * Claim before configuring audio and release only after the audio session is torn down; the
 * native `realtimeVoiceOwnsAudio()` check covers native ownership, this covers the JS windows
 * before and after it.
 */
export function createMicrophoneArbiter() {
  let holder: MicrophoneHolder | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: MicrophoneHolder | null) => {
    holder = next;
    for (const listener of listeners) listener();
  };
  return {
    holder: () => holder,
    acquire(next: MicrophoneHolder): boolean {
      if (holder === next) return true;
      if (holder !== null) return false;
      publish(next);
      return true;
    },
    release(previous: MicrophoneHolder): void {
      if (holder === previous) publish(null);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type MicrophoneArbiter = ReturnType<typeof createMicrophoneArbiter>;

export const microphoneArbiter = createMicrophoneArbiter();
