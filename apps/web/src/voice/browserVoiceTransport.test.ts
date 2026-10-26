import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createBrowserVoiceTransport } from "./browserVoiceTransport";

function fixture(contextState: AudioContextState = "running") {
  let grant: (stream: { getTracks(): Track[] }) => void = () => {};
  const permission = new Promise<{ getTracks(): Track[] }>((resolve) => {
    grant = resolve;
  });
  class Track extends EventTarget {
    enabled = true;
    stop = vi.fn();
  }
  class Channel extends EventTarget {
    readyState = "open";
    close = vi.fn();
  }
  const channel = new Channel();
  const addTrack = vi.fn();
  const closePeer = vi.fn();
  class Peer extends EventTarget {
    connectionState = "connected";
    iceGatheringState = "complete";
    localDescription = { sdp: "offer" };
    createDataChannel = () => channel;
    createOffer = async () => ({ type: "offer", sdp: "offer" });
    setLocalDescription = async () => {};
    setRemoteDescription = async () => {};
    addTrack = addTrack;
    close = closePeer;
  }
  // Frames flow from the microphone source only along live connections, as in Web Audio.
  const outputTrack = new Track();
  const sent: string[] = [];
  const output = {
    stream: { getAudioTracks: () => [outputTrack], getTracks: () => [outputTrack] },
    receive: (frame: string) => sent.push(frame),
  };
  // The post-open discard is a gain ramp; frames here are the ones it lets through.
  const opening = {
    target: null as typeof output | null,
    gain: { value: 1, setValueAtTime: vi.fn() },
    connect: (target: typeof output) => {
      opening.target = target;
    },
    receive: (frame: string) => opening.target?.receive(frame),
  };
  const source = {
    target: null as typeof opening | null,
    connect: vi.fn((target: typeof opening) => {
      source.target = target;
    }),
    disconnect: vi.fn(() => {
      source.target = null;
    }),
  };
  const captureFrame = (frame: string) => source.target?.receive(frame);
  const closeContext = vi.fn(async () => {});
  const resumeContext = vi.fn(async () => {});
  const contexts: FakeAudioContext[] = [];
  class FakeAudioContext extends EventTarget {
    state = contextState;
    createMediaStreamSource = () => source;
    createMediaStreamDestination = () => output;
    createGain = () => opening;
    currentTime = 0;
    sampleRate = 48_000;
    resume = resumeContext;
    close = closeContext;
    constructor() {
      super();
      contexts.push(this);
    }
  }
  const audio = Object.assign(new EventTarget(), {
    autoplay: false,
    srcObject: null,
    pause: vi.fn(),
    remove: vi.fn(),
  });
  const devices = Object.assign(new EventTarget(), { getUserMedia: vi.fn(() => permission) });
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("document", { createElement: () => audio });
  vi.stubGlobal("navigator", { mediaDevices: devices });
  const failed = vi.fn();
  const connected = vi.fn();
  const transport = createBrowserVoiceTransport({ connected, failed });
  const track = new Track();
  const stream = { getTracks: () => [track] };
  return {
    transport,
    track,
    stream,
    grant,
    addTrack,
    closePeer,
    channel,
    audio,
    devices,
    failed,
    outputTrack,
    source,
    sent,
    captureFrame,
    closeContext,
    resumeContext,
    connected,
    setContextState: (state: AudioContextState) => {
      contexts[0]!.state = state;
      contexts[0]!.dispatchEvent(new Event("statechange"));
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("browser voice resource ownership", () => {
  it("releases a microphone granted after cancellation without attaching it to the peer", async () => {
    const f = fixture();
    const pending = f.transport.acquireMicrophone();
    f.transport.close();
    f.grant(f.stream);
    await pending;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.addTrack).not.toHaveBeenCalled();
    expect(f.closePeer).toHaveBeenCalledOnce();
    expect(f.channel.close).toHaveBeenCalledOnce();
  });

  it("starts with disabled input and stops capture, peer and sink idempotently", async () => {
    const f = fixture();
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    expect(f.track.enabled).toBe(false);
    f.transport.enableMicrophone();
    expect(f.track.enabled).toBe(true);
    f.transport.close();
    f.transport.close();
    f.transport.enableMicrophone();
    expect(f.track.enabled).toBe(false);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.closePeer).toHaveBeenCalledOnce();
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(f.audio.pause).toHaveBeenCalledOnce();
    expect(f.audio.srcObject).toBeNull();
    expect(f.audio.remove).toHaveBeenCalledOnce();
    expect(f.closeContext).toHaveBeenCalledOnce();
    f.track.dispatchEvent(new Event("ended"));
    f.devices.dispatchEvent(new Event("devicechange"));
    expect(f.failed).not.toHaveBeenCalled();
  });

  it("gives the sender only gated output and forwards no frame after close", async () => {
    const f = fixture();
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    expect(f.addTrack).toHaveBeenCalledExactlyOnceWith(f.outputTrack, expect.anything());
    f.captureFrame("before-approval");
    f.transport.enableMicrophone();
    f.captureFrame("approved");
    f.transport.close();
    f.captureFrame("after-pause");
    f.transport.enableMicrophone();
    f.captureFrame("after-reopen-attempt");
    expect(f.sent).toEqual(["approved"]);
    expect(f.source.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      f.closePeer.mock.invocationCallOrder[0]!,
    );
    expect(f.outputTrack.stop).toHaveBeenCalledOnce();
  });

  it("reports not connected and sends nothing while autoplay keeps the audio context suspended", async () => {
    const f = fixture("suspended");
    expect(f.resumeContext).toHaveBeenCalledOnce();
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    expect(f.transport.isConnected()).toBe(false);
    f.transport.enableMicrophone();
    f.captureFrame("while-suspended");
    f.setContextState("running");
    expect(f.connected).toHaveBeenCalledOnce();
    expect(f.transport.isConnected()).toBe(true);
    f.transport.enableMicrophone();
    f.captureFrame("running");
    expect(f.sent).toEqual(["running"]);
    expect(f.failed).not.toHaveBeenCalled();
    f.setContextState("suspended");
    expect(f.failed).toHaveBeenCalledOnce();
  });
});
