import type { VoiceTransport } from "@t3tools/client-runtime/realtime-voice";

import type { RealtimeVoiceAudio } from "../../native/realtimeVoiceAudio";

interface TransportEvents {
  connected(): void;
  failed(reason: string): void;
}

/**
 * The single seam for the native WebRTC transport. The transport passes `nativeOwner` to
 * `audio.prepare` and reports the resolved generation through `prepared`; revocations for that
 * owner and generation end the session.
 */
export type MobileVoiceTransportFactory = (
  audio: RealtimeVoiceAudio,
  nativeOwner: string,
  events: TransportEvents & { prepared(generation: number): void },
) => VoiceTransport;

// No transport until native WebRTC is proven on a device. Start stays unavailable meanwhile.
export const mobileVoiceTransport: MobileVoiceTransportFactory | null = null;

function describeRevocation(reason: string): string {
  switch (reason) {
    case "interruption":
      return "Microphone off. A call or another app interrupted voice. Start a new call when ready.";
    case "mediaServicesReset":
      return "Microphone off. iOS reset its audio services. Start a new call when ready.";
    case "audioFault":
      return "Microphone off. The audio device failed. Start a new call when ready.";
    default:
      return "Microphone off. The audio route changed. Start a new call when ready.";
  }
}

/**
 * Creates one transport whose native revocations are terminal for its session. Events for other
 * owners or older generations are ignored, and the subscription ends with the transport.
 */
export function createRevocableTransport(
  audio: RealtimeVoiceAudio,
  factory: MobileVoiceTransportFactory,
  nativeOwner: string,
  events: TransportEvents,
): VoiceTransport {
  let generation: number | null = null;
  let open = true;
  const subscription = audio.addRevokedListener((event) => {
    // The owner token is unique to this transport, so a match before `prepared` is still ours.
    if (!open || event.owner !== nativeOwner) return;
    if (generation !== null && event.generation !== generation) return;
    open = false;
    subscription.remove();
    events.failed(describeRevocation(event.reason));
  });
  let transport: VoiceTransport;
  try {
    transport = factory(audio, nativeOwner, {
      connected: () => events.connected(),
      failed: (reason) => events.failed(reason),
      prepared: (value) => {
        generation = value;
      },
    });
  } catch (error) {
    subscription.remove();
    throw error;
  }
  return {
    acquireMicrophone: () => transport.acquireMicrophone(),
    createOffer: () => transport.createOffer(),
    setLocalDescription: (offer) => transport.setLocalDescription(offer),
    gatherIce: () => transport.gatherIce(),
    localSdp: () => transport.localSdp(),
    setRemoteDescription: (sdp) => transport.setRemoteDescription(sdp),
    isConnected: () => open && transport.isConnected(),
    enableMicrophone: () => {
      if (open) transport.enableMicrophone();
    },
    close: () => {
      open = false;
      subscription.remove();
      transport.close();
    },
  };
}
