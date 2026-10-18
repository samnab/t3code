import { useEffect, useRef, useState } from "react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { ProviderRealtimeVoiceError, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { AudioLinesIcon, MicIcon } from "lucide-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

/**
 * Realtime voice mode for Codex threads. The browser talks to OpenAI's realtime
 * model over WebRTC; the T3 server only relays the SDP offer/answer through the
 * thread's provider session, so audio never touches it. Web-only on purpose —
 * share with mobile only when a second surface actually needs it.
 */

/** Wait for ICE gathering so the offer already describes reachable candidates,
 * capped so a stalled final candidate cannot hang the connect flow. */
const ICE_GATHERING_TIMEOUT_MS = 2_000;

type RealtimeVoiceStatus = "idle" | "connecting" | "live";

type RealtimeVoiceSession = {
  readonly peerConnection: RTCPeerConnection;
  readonly audioElement: HTMLAudioElement;
  readonly microphone: MediaStream | null;
};

function stopRealtimeVoiceSession(session: RealtimeVoiceSession): void {
  session.peerConnection.ontrack = null;
  session.peerConnection.onconnectionstatechange = null;
  session.peerConnection.close();
  if (session.microphone !== null) {
    for (const track of session.microphone.getTracks()) track.stop();
  }
  session.audioElement.srcObject = null;
  session.audioElement.remove();
}

function waitForIceGathering(peerConnection: RTCPeerConnection): Promise<void> {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
      peerConnection.removeEventListener("icecandidate", onCandidate);
      clearTimeout(cap);
      resolve();
    };
    const onStateChange = () => {
      if (peerConnection.iceGatheringState === "complete") finish();
    };
    // A null candidate marks the end of trickle gathering.
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate === null) finish();
    };
    const cap = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    peerConnection.addEventListener("icegatheringstatechange", onStateChange);
    peerConnection.addEventListener("icecandidate", onCandidate);
  });
}

// The throwing helpers live outside the component: the React Compiler cannot
// lower a throw inside try/catch.
function requireLocalSdp(peerConnection: RTCPeerConnection): string {
  const localSdp = peerConnection.localDescription?.sdp;
  if (localSdp === undefined) throw new Error("No local SDP description was generated.");
  return localSdp;
}

function requireSuccess<A, E>(result: AtomCommandResult<A, E>): A {
  if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
  return result.value;
}

const isProviderRealtimeVoiceError = Schema.is(ProviderRealtimeVoiceError);

function describeRealtimeVoiceFailure(error: unknown): string {
  if (isProviderRealtimeVoiceError(error) && typeof error.cause === "string") {
    return error.cause;
  }
  return error instanceof Error ? error.message : String(error);
}

export function RealtimeVoiceControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  size: ComposerControlSize;
}) {
  const { environmentId, threadId, size } = props;
  const [status, setStatus] = useState<RealtimeVoiceStatus>("idle");
  const sessionRef = useRef<RealtimeVoiceSession | null>(null);
  const startVoice = useOrchestrationCommand(threadEnvironment.startRealtimeVoice, {
    reportFailure: false,
  });
  const stopVoice = useOrchestrationCommand(threadEnvironment.stopRealtimeVoice, {
    reportFailure: false,
  });

  const endSession = () => {
    const session = sessionRef.current;
    if (session === null) return;
    sessionRef.current = null;
    stopRealtimeVoiceSession(session);
    setStatus("idle");
  };

  // Leaving the view, switching threads, or a dead connection all end the
  // call. The stop command tells the provider session so its side tears down
  // too, even when the browser side already has.
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session !== null) {
        void stopVoice({ environmentId, input: { threadId } });
        stopRealtimeVoiceSession(session);
      }
    };
  }, [environmentId, threadId, stopVoice]);

  const start = async () => {
    if (sessionRef.current !== null) return;
    setStatus("connecting");
    const peerConnection = new RTCPeerConnection();
    const audioElement = document.createElement("audio");
    audioElement.autoplay = true;
    let microphone: MediaStream | null = null;
    try {
      microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Codex expects the realtime events data channel in the offer.
      peerConnection.createDataChannel("oai-events");
      peerConnection.ontrack = (event) => {
        audioElement.srcObject = event.streams[0] ?? null;
      };
      for (const track of microphone.getTracks()) {
        peerConnection.addTrack(track, microphone);
      }
      const session: RealtimeVoiceSession = { peerConnection, audioElement, microphone };
      sessionRef.current = session;
      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        if (state === "failed" || state === "closed") {
          const wasActive = sessionRef.current === session;
          endSession();
          if (wasActive && state === "failed") {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Voice connection failed",
                description: "The call ended early. Try starting it again.",
              }),
            );
          }
        }
      };
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await waitForIceGathering(peerConnection);
      const result = await startVoice({
        environmentId,
        input: { threadId, sdp: requireLocalSdp(peerConnection) },
      });
      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: requireSuccess(result).sdp,
      });
      setStatus("live");
    } catch (error) {
      // A mid-flow failure must not leave the mic open or the stored session
      // alive; endSession handles the stored one, this handles the rest.
      endSession();
      stopRealtimeVoiceSession({ peerConnection, audioElement, microphone });
      setStatus("idle");
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Voice mode failed to start",
          description: describeRealtimeVoiceFailure(error),
        }),
      );
    }
  };

  const stop = async () => {
    if (sessionRef.current === null) return;
    endSession();
    const result = await stopVoice({ environmentId, input: { threadId } });
    if (AsyncResult.isFailure(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to end voice mode",
          description: describeRealtimeVoiceFailure(Cause.squash(result.cause)),
        }),
      );
    }
  };

  const tooltip = status === "live" ? "Voice mode — click to end" : "Talk with Codex by voice";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0 whitespace-nowrap"
            aria-pressed={status === "live"}
            type="button"
            disabled={status === "connecting"}
            onClick={() => (status === "live" ? void stop() : void start())}
            aria-label={tooltip}
          />
        }
      >
        <ComposerControlIcon
          icon={status === "live" ? AudioLinesIcon : MicIcon}
          size={size}
          opticalSize={size === "xs" ? "default" : "large"}
        />
        <span data-composer-control-label className="sr-only sm:not-sr-only">
          {status === "connecting" ? "Connecting" : "Voice"}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
