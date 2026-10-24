import {
  createRealtimeVoiceController,
  type VoiceOwner,
} from "@t3tools/client-runtime/realtime-voice";

import type { RealtimeVoiceAudio } from "../../native/realtimeVoiceAudio";
import type { MicrophoneArbiter } from "./microphoneArbiter";
import { createRevocableTransport, type MobileVoiceTransportFactory } from "./nativeVoiceTransport";

type ControllerDeps = Parameters<typeof createRealtimeVoiceController>[0];

export const VOICE_UNAVAILABLE = "Voice conversations are not available on this device yet.";
export const VOICE_BLOCKED_BY_DICTATION = "Finish dictation before starting a voice conversation.";

/**
 * The app's single realtime voice owner on mobile. It drives the shared privacy controller and
 * adds what mobile needs around it: the native gated transport seam, terminal native revocation,
 * and the microphone claim against dictation. `available` is false until both the native audio
 * owner and a transport exist; `start` then rejects instead of faking a call.
 */
export function createMobileRealtimeVoiceOwner(
  deps: Omit<ControllerDeps, "createTransport"> & {
    readonly audio: RealtimeVoiceAudio | null;
    readonly transport: MobileVoiceTransportFactory | null;
    readonly arbiter: MicrophoneArbiter;
  },
) {
  const { audio, transport, arbiter } = deps;
  const controller = createRealtimeVoiceController({
    ...deps,
    createTransport: (events) => {
      if (audio === null || transport === null) throw new Error(VOICE_UNAVAILABLE);
      return createRevocableTransport(audio, transport, deps.createOperationId(), events);
    },
  });
  // Every non-off mode, including any added later, keeps the microphone claimed.
  const releaseIfOff = () => {
    if (controller.getSnapshot().mode === "off") arbiter.release("realtime-voice");
  };
  controller.subscribe(releaseIfOff);
  return {
    available: audio !== null && transport !== null,
    /** Only for an explicit user action. Nothing restarts a call on its own. */
    start: async (owner: VoiceOwner) => {
      if (audio === null || transport === null) throw new Error(VOICE_UNAVAILABLE);
      if (controller.getSnapshot().mode !== "off") return;
      if (!arbiter.acquire("realtime-voice")) throw new Error(VOICE_BLOCKED_BY_DICTATION);
      try {
        await controller.start(owner);
      } finally {
        // The controller declines some starts without publishing, such as a replacement gate.
        releaseIfOff();
      }
    },
    end: controller.end,
    getSnapshot: controller.getSnapshot,
    subscribe: controller.subscribe,
  };
}

export type MobileRealtimeVoiceOwner = ReturnType<typeof createMobileRealtimeVoiceOwner>;
