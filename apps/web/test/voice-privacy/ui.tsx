/**
 * Renders the shipped voice pill and composer strip against the shipped provider, controller and
 * transport, with a synthetic microphone and a local answering peer, for layout screenshots.
 * `?view=owner|other` picks the thread on screen; the buttons in the harness bar drive the call.
 */
import "./ui.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderRealtimeVoiceStartResult } from "@t3tools/contracts";
import type { VoiceOperationOwner } from "@t3tools/client-runtime/realtime-voice";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import {
  GlobalRealtimeVoiceControl,
  RealtimeVoiceComposerStrip,
} from "../../src/components/voice/GlobalRealtimeVoiceControl";
import {
  RealtimeVoiceProvider,
  useRealtimeVoice,
} from "../../src/components/voice/RealtimeVoiceProvider";
import { harnessOwner } from "./owner";
import { providerHooks, RouteContext } from "./stubs";
import resumePhraseUrl from "./fixtures/resume-phrase.wav?url";

const owner = harnessOwner();
const other = {
  environmentId: owner.environmentId,
  threadId: "thread-other" as typeof owner.threadId,
};

// A pulsing tone, so the level meters move.
function tone(frequency: number) {
  const context = new AudioContext();
  const oscillator = new OscillatorNode(context, { frequency });
  const amplitude = new GainNode(context, { gain: 0.3 });
  const lfo = new OscillatorNode(context, { frequency: 1.5 });
  const depth = new GainNode(context, { gain: 0.3 });
  lfo.connect(depth).connect(amplitude.gain);
  const destination = context.createMediaStreamDestination();
  oscillator.connect(amplitude).connect(destination);
  oscillator.start();
  lfo.start();
  return { context, amplitude, destination, stream: destination.stream };
}
const microphone = tone(440);
navigator.mediaDevices.getUserMedia = async () => microphone.stream.clone();
// Speaks the shipped "resume voice" fixture into the microphone, so the real detector arms.
async function sayResume() {
  const data = await (await fetch(resumePhraseUrl)).arrayBuffer();
  const source = new AudioBufferSourceNode(microphone.context, {
    buffer: await microphone.context.decodeAudioData(data),
  });
  // The tone would mask the phrase for the detector.
  microphone.amplitude.disconnect();
  source.addEventListener("ended", () => microphone.amplitude.connect(microphone.destination));
  source.connect(microphone.destination);
  source.start();
}

// While held, the provider's start and stop wait for "release", so connecting and ending stay up.
let held = false;
let releases: Array<() => void> = [];
const gate = () =>
  held ? new Promise<void>((resolve) => releases.push(resolve)) : Promise.resolve();
const release = () => {
  held = false;
  for (const resolve of releases) resolve();
  releases = [];
};
providerHooks.stop = gate;

providerHooks.start = async (
  start: VoiceOperationOwner,
  sdp: string,
): Promise<ProviderRealtimeVoiceStartResult> => {
  await gate();
  const peer = new RTCPeerConnection();
  await peer.setRemoteDescription({ type: "offer", sdp });
  const assistant = tone(220).stream;
  for (const track of assistant.getAudioTracks()) peer.addTrack(track, assistant);
  await peer.setLocalDescription(await peer.createAnswer());
  await new Promise<void>((resolve) => {
    if (peer.iceGatheringState === "complete") resolve();
    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") resolve();
    });
  });
  return {
    operationId: start.operationId,
    voiceSessionToken: "token-ui",
    providerInstanceId: start.providerInstanceId,
    providerThreadId: start.providerThreadId,
    providerSessionId: start.providerSessionId,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    sdp: peer.localDescription?.sdp ?? "",
  };
};

type View = "owner" | "other" | "owner-no-composer";

function Page({ view, setView }: { view: View; setView: (view: View) => void }) {
  const voice = useRealtimeVoice();
  const ref = view === "other" ? other : owner;
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex gap-2 border-b border-dashed p-1 text-xs text-muted-foreground">
        <button type="button" onClick={() => voice.start(owner.environmentId, owner.threadId)}>
          harness: start
        </button>
        <button type="button" onClick={() => setView("owner")}>
          harness: view owner
        </button>
        <button type="button" onClick={() => setView("other")}>
          harness: view other
        </button>
        <button type="button" onClick={() => setView("owner-no-composer")}>
          harness: view owner without composer
        </button>
        <button type="button" onClick={() => (held = true)}>
          harness: hold provider
        </button>
        <button type="button" onClick={release}>
          harness: release provider
        </button>
        <button type="button" onClick={() => void sayResume()}>
          harness: say resume voice
        </button>
        <span data-testid="mode">{voice.snapshot.mode}</span>
      </div>
      <header className="@container flex h-11 items-center gap-2 border-b px-3 text-sm">
        <span className="truncate">{view === "other" ? "Another thread" : owner.threadTitle}</span>
        <RouteContext value={ref}>
          <GlobalRealtimeVoiceControl className="ms-auto" ownerHasComposer={view === "owner"} />
        </RouteContext>
      </header>
      <main className="flex min-h-0 flex-1 flex-col p-4">
        <p className="mx-auto w-full max-w-3xl text-sm text-muted-foreground">
          Yes, that is plausible. The desktop test separates those possibilities.
        </p>
        {view === "owner-no-composer" ? (
          <p className="mx-auto mt-auto text-sm text-muted-foreground">
            No composer on this view (for example a provider subagent thread).
          </p>
        ) : (
          <form className="mx-auto mt-auto w-full min-w-0 max-w-3xl" data-chat-composer-form="true">
            <ComposerBanner.Dock>
              <ComposerBanner.Column>
                <RealtimeVoiceComposerStrip threadRef={ref} />
              </ComposerBanner.Column>
            </ComposerBanner.Dock>
            <div
              contentEditable
              suppressContentEditableWarning
              data-testid="composer-editor"
              className="relative min-h-24 rounded-2xl border bg-card p-3 text-sm text-muted-foreground focus:outline-2 focus:outline-ring"
            >
              Ask anything. @ files, $ skills, / commands
            </div>
          </form>
        )}
      </main>
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>(
    new URLSearchParams(location.search).get("view") === "other" ? "other" : "owner",
  );
  return (
    <RealtimeVoiceProvider returnToOwner={() => setView("owner")}>
      <Page view={view} setView={setView} />
    </RealtimeVoiceProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
