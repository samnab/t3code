// iOS feeds WebRTC only through a default-deny native send gate; other platforms must not
// fall back to an ungated mic. Order: `prepare(owner)`, create the peer, require
// `snapshot().adopted`, `openGate`, renew the lease while sending, then `closeGate`/`end`.
// A failed renewal means native code already closed the gate.
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
  /**
   * Resolves with the owner generation. Rejects `interrupted`
   * (`ERR_REALTIME_VOICE_INTERRUPTED`) when native code ended the owner; prepare again only on
   * a new user action.
   */
  readonly prepare: (owner: string) => Promise<number>;
  /** Returns an opaque epoch, or 0 when the gate could not open. */
  readonly openGate: (owner: string, leaseSeconds: number) => number;
  /** Extends an open epoch. Never reopens a closed or expired one. */
  readonly renewLease: (epoch: number, leaseSeconds: number) => boolean;
  readonly closeGate: (epoch: number) => boolean;
  readonly end: (owner: string) => Promise<boolean>;
  readonly snapshot: () => RealtimeVoiceAudioSnapshot;
  // Terminal: fires once after a fault, after native code closed the gate and released audio;
  // never for a deliberate `end`. `prepare` may reject `busy` until teardown finishes.
  // Prepare again only on a new user action.
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
