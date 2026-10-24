import { requireOptionalNativeModule, type EventSubscription } from "expo";

import type { RealtimeVoiceAudio, RealtimeVoiceAudioSnapshot } from "./realtimeVoiceAudio";

export type { RealtimeVoiceAudio, RealtimeVoiceAudioSnapshot } from "./realtimeVoiceAudio";

interface NativeRealtimeVoiceAudio {
  prepare(owner: string): Promise<void>;
  openGate(owner: string, leaseSeconds: number): number;
  renewLease(epoch: number, leaseSeconds: number): boolean;
  closeGate(epoch: number): boolean;
  end(owner: string): Promise<boolean>;
  snapshot(): RealtimeVoiceAudioSnapshot;
  addListener(
    event: "onRevoked",
    listener: (event: { readonly reason: string }) => void,
  ): EventSubscription;
}

const native = requireOptionalNativeModule<NativeRealtimeVoiceAudio>("T3RealtimeVoiceAudio");

export function getRealtimeVoiceAudio(): RealtimeVoiceAudio | null {
  if (!native || !native.snapshot().installed) return null;
  return {
    prepare: (owner) => native.prepare(owner),
    openGate: (owner, leaseSeconds) => native.openGate(owner, leaseSeconds),
    renewLease: (epoch, leaseSeconds) => native.renewLease(epoch, leaseSeconds),
    closeGate: (epoch) => native.closeGate(epoch),
    end: (owner) => native.end(owner),
    snapshot: () => native.snapshot(),
    addRevokedListener: (listener) =>
      native.addListener("onRevoked", (event) => listener(event.reason)),
  };
}

export function realtimeVoiceOwnsAudio(): boolean {
  return native?.snapshot().owned ?? false;
}
