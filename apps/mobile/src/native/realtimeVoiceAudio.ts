/**
 * Native owner of realtime voice audio. The iOS build feeds WebRTC only through a
 * default-deny native send gate; other platforms report unsupported and must not
 * fall back to an ungated microphone track.
 *
 * Call order for one user-started conversation: `prepare(owner)`, create the
 * react-native-webrtc peer, require `snapshot().adopted`, then `openGate`, renew
 * the epoch's lease while sending, and `closeGate`/`end` with the same values.
 */
export interface RealtimeVoiceAudioSnapshot {
  readonly installed: boolean;
  readonly adopted: boolean;
  readonly owned: boolean;
  readonly armed: boolean;
  /** Opaque. 0 when the gate is closed. */
  readonly epoch: number;
}

export interface RealtimeVoiceAudio {
  readonly prepare: (owner: string) => Promise<void>;
  /** Returns an opaque epoch, or 0 when the gate could not open. */
  readonly openGate: (owner: string, leaseSeconds: number) => number;
  /** Extends an open epoch. Never reopens a closed or expired one. */
  readonly renewLease: (epoch: number, leaseSeconds: number) => boolean;
  readonly closeGate: (epoch: number) => boolean;
  readonly end: (owner: string) => Promise<boolean>;
  readonly snapshot: () => RealtimeVoiceAudioSnapshot;
  /** Fires after native code already closed the gate (interruption, route loss, reset). */
  readonly addRevokedListener: (listener: (reason: string) => void) => { remove: () => void };
}

export function getRealtimeVoiceAudio(): RealtimeVoiceAudio | null {
  return null;
}

export function realtimeVoiceOwnsAudio(): boolean {
  return false;
}
