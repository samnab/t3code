/**
 * Native owner of realtime voice audio. The iOS build feeds WebRTC only through a
 * default-deny native send gate; other platforms report unsupported and must not
 * fall back to an ungated microphone track.
 *
 * Call order for one user-started conversation: `prepare(owner)`, create the
 * react-native-webrtc peer, require `snapshot().adopted`, then `openGate`, renew
 * the epoch's lease while sending, and `closeGate`/`end` with the same values.
 * Each `prepare` starts a new capture lifetime and closes any open epoch. A failed
 * renewal means native code closed the gate (lease expiry, revocation or audio fault).
 */
export interface RealtimeVoiceAudioSnapshot {
  readonly installed: boolean;
  readonly adopted: boolean;
  readonly owned: boolean;
  /** Generation of the current owner, 0 when unowned. */
  readonly generation: number;
  readonly armed: boolean;
  /** Opaque. 0 when the gate is closed. */
  readonly epoch: number;
}

export interface RealtimeVoiceAudioRevoked {
  readonly reason: string;
  readonly owner: string;
  /** Matches the value `prepare` resolved with; reject events from older owners. */
  readonly generation: number;
}

export interface RealtimeVoiceAudio {
  /** Resolves with the owner generation. */
  readonly prepare: (owner: string) => Promise<number>;
  /** Returns an opaque epoch, or 0 when the gate could not open. */
  readonly openGate: (owner: string, leaseSeconds: number) => number;
  /** Extends an open epoch. Never reopens a closed or expired one. */
  readonly renewLease: (epoch: number, leaseSeconds: number) => boolean;
  readonly closeGate: (epoch: number) => boolean;
  readonly end: (owner: string) => Promise<boolean>;
  readonly snapshot: () => RealtimeVoiceAudioSnapshot;
  /**
   * Terminal. Fires once after a fault (`interruption`, `route:N`, `mediaServicesReset` or
   * `audioFault`) only when native code has already closed the gate, ended the owner and
   * released the audio session. Never fires for a deliberate `end`. After any end, `prepare`
   * may reject `busy` until native teardown finishes; for a fault, that is when this fires.
   * Prepare again only on a new user action.
   */
  readonly addRevokedListener: (listener: (event: RealtimeVoiceAudioRevoked) => void) => {
    remove: () => void;
  };
}

export function getRealtimeVoiceAudio(): RealtimeVoiceAudio | null {
  return null;
}

export function realtimeVoiceOwnsAudio(): boolean {
  return false;
}
