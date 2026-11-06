import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createBrowserVoiceTransport } from "./browserVoiceTransport";

function fixture(contextState: AudioContextState = "running", tapKeywords = false) {
  let grant: (stream: { getTracks(): Track[] }) => void = () => {};
  let deny: (error: Error) => void = () => {};
  const permission = new Promise<{ getTracks(): Track[] }>((resolve, reject) => {
    grant = resolve;
    deny = reject;
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
    // The gate also feeds the input meter; only the sender's destination carries frames here.
    connect: (target: object) => {
      if (target === output) opening.target = output;
    },
    disconnect: () => {
      opening.target = null;
    },
    receive: (frame: string) => opening.target?.receive(frame),
  };
  // Web Audio semantics: `disconnect(target)` drops one connection, bare `disconnect()` drops all,
  // including the keyword detector's tap.
  type Target = { receive(frame: string): void };
  const source = {
    targets: new Set<Target>(),
    connect: vi.fn((target: Target) => {
      source.targets.add(target);
    }),
    disconnect: vi.fn((target?: Target) => {
      if (target === undefined) source.targets.clear();
      else source.targets.delete(target);
    }),
  };
  const captureFrame = (frame: string) => {
    for (const target of source.targets) target.receive(frame);
  };
  const heardByKeywords: string[] = [];
  const keywordTap = { receive: (frame: string) => heardByKeywords.push(frame) };
  const closeContext = vi.fn(async () => {});
  const resumeContext = vi.fn(async () => {});
  const contexts: FakeAudioContext[] = [];
  // The zero source that keeps the sender's track producing frames; tracks what it feeds.
  const silence = {
    offset: { value: 1 },
    feeds: 0,
    connect: () => {
      silence.feeds += 1;
    },
    disconnect: () => {
      silence.feeds -= 1;
    },
    start: () => {},
  };
  // Each analyser reports a steady level; the first created meters input, the second the assistant.
  const analysers: Array<{ level: number }> = [];
  const createAnalyser = () => {
    const analyser = {
      level: 0,
      fftSize: 4,
      getFloatTimeDomainData: (frame: Float32Array) => frame.fill(analyser.level),
    };
    analysers.push(analyser);
    return analyser;
  };
  const context = () => contexts[0]!;
  class FakeAudioContext extends EventTarget {
    state = contextState;
    // The remote stream only feeds the assistant meter.
    createMediaStreamSource = (stream: object) => ("id" in stream ? { connect: () => {} } : source);
    createMediaStreamDestination = () => output;
    createGain = () => opening;
    createConstantSource = () => silence;
    createAnalyser = createAnalyser;
    currentTime = 0;
    sampleRate = 48_000;
    resume = resumeContext;
    close = closeContext;
    constructor(readonly options?: AudioContextOptions) {
      super();
      contexts.push(this);
    }
  }
  const audio = Object.assign(new EventTarget(), {
    autoplay: false,
    srcObject: null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    remove: vi.fn(),
  });
  const devices = Object.assign(new EventTarget(), { getUserMedia: vi.fn(() => permission) });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("document", { createElement: () => audio });
  vi.stubGlobal("navigator", { mediaDevices: devices });
  const peers: Peer[] = [];
  vi.stubGlobal(
    "RTCPeerConnection",
    class extends Peer {
      constructor() {
        super();
        peers.push(this);
      }
    },
  );
  const failed = vi.fn();
  const connected = vi.fn();
  const transport = createBrowserVoiceTransport(
    { connected, failed },
    tapKeywords
      ? async () => {
          source.connect(keywordTap);
          return () => source.disconnect(keywordTap);
        }
      : undefined,
  );
  const track = new Track();
  const stream = { getTracks: () => [track] };
  return {
    transport,
    track,
    stream,
    grant,
    deny,
    contexts,
    addTrack,
    closePeer,
    channel,
    audio,
    devices,
    failed,
    outputTrack,
    source,
    sent,
    heardByKeywords,
    captureFrame,
    closeContext,
    resumeContext,
    connected,
    opening,
    silence,
    context,
    setLevels: (input: number, output: number) => {
      analysers[0]!.level = input;
      analysers[1]!.level = output;
    },
    remoteStream: () => {
      const remote = { id: "remote" };
      peers[0]!.dispatchEvent(Object.assign(new Event("track"), { streams: [remote] }));
      return remote;
    },
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
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    expect(f.resumeContext).toHaveBeenCalledOnce();
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

  // On a Bluetooth output, a context opened just after the last call's closed blocked the renderer
  // for 10 s. The graph only feeds the peer and meters; playback is the <audio> element.
  it("builds its audio context without an output device", async () => {
    const f = fixture();
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    expect(f.contexts[0]?.options).toEqual({ sinkId: { type: "none" } });
    f.transport.close();
  });

  // With CoreAudio stalled, constructing an AudioContext blocked the renderer for 20 s before
  // getUserMedia could report "Requested device not found".
  it("fails a missing microphone without constructing an audio context", async () => {
    const f = fixture();
    const pending = f.transport.acquireMicrophone();
    f.deny(new DOMException("Requested device not found", "NotFoundError"));
    await expect(pending).rejects.toThrow("Requested device not found");
    expect(f.contexts).toHaveLength(0);
    f.transport.close();
    expect(f.closePeer).toHaveBeenCalledOnce();
  });
});

describe("browser voice microphone mute", () => {
  async function live() {
    const f = fixture("running", true);
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    f.transport.enableMicrophone();
    return f;
  }

  it("shuts the gate while muted, keeps the keyword tap and playback, and stops cleanly", async () => {
    const f = await live();
    const remote = f.remoteStream();
    f.captureFrame("A");
    f.transport.setMicMuted?.(true);
    f.captureFrame("B");
    f.captureFrame("B2");
    expect(f.sent).toEqual(["A"]);
    // The keyword detector still hears a spoken pause while muted.
    expect(f.heardByKeywords).toEqual(["A", "B", "B2"]);
    expect(f.track.enabled).toBe(true);
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.outputTrack.stop).not.toHaveBeenCalled();
    expect(f.closePeer).not.toHaveBeenCalled();
    expect(f.channel.close).not.toHaveBeenCalled();
    expect(f.audio.srcObject).toBe(remote);
    expect(f.audio.pause).not.toHaveBeenCalled();
    expect(f.transport.isConnected()).toBe(true);
    expect(f.failed).not.toHaveBeenCalled();
    // Stop session while muted releases everything.
    f.transport.close();
    f.captureFrame("after-stop");
    expect(f.sent).toEqual(["A"]);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.outputTrack.stop).toHaveBeenCalledOnce();
    expect(f.closePeer).toHaveBeenCalledOnce();
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(f.audio.srcObject).toBeNull();
    expect(f.closeContext).toHaveBeenCalledOnce();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it("unmutes through a fresh gate that discards the first 64 ms and keeps nothing from the mute", async () => {
    const f = await live();
    f.transport.setMicMuted?.(true);
    f.captureFrame("B");
    f.context().currentTime = 5;
    f.opening.gain.setValueAtTime.mockClear();
    f.opening.gain.value = 1;
    f.transport.setMicMuted?.(false);
    expect(f.opening.gain.value).toBe(0);
    expect(f.opening.gain.setValueAtTime).toHaveBeenCalledExactlyOnceWith(1, 5 + 0.064);
    f.captureFrame("C");
    expect(f.sent).toEqual(["C"]);
  });

  it("keeps a gate muted before it opens shut when the call connects, and ignores mute after close", async () => {
    const f = fixture();
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    f.transport.setMicMuted?.(true);
    f.transport.enableMicrophone();
    f.captureFrame("while-connecting-muted");
    expect(f.sent).toEqual([]);
    f.transport.close();
    f.transport.setMicMuted?.(false);
    f.captureFrame("after-close");
    expect(f.sent).toEqual([]);
  });

  it("detaches the zero source from each replaced gate", async () => {
    const f = await live();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      f.transport.setMicMuted?.(true);
      f.transport.setMicMuted?.(false);
    }
    expect(f.silence.feeds).toBe(1);
  });
});

describe("browser voice levels", () => {
  it("reads input only through an open, unmuted gate and the assistant throughout a mute", async () => {
    const f = fixture();
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    f.setLevels(0.5, 0.25);
    expect(f.transport.levels?.()).toEqual({ input: 0, output: 0 });
    f.remoteStream();
    expect(f.transport.levels?.()).toEqual({ input: 0, output: 0.25 });
    f.transport.enableMicrophone();
    expect(f.transport.levels?.()).toEqual({ input: 0.5, output: 0.25 });
    f.transport.setMicMuted?.(true);
    expect(f.transport.levels?.()).toEqual({ input: 0, output: 0.25 });
    f.transport.setMicMuted?.(false);
    expect(f.transport.levels?.()).toEqual({ input: 0.5, output: 0.25 });
    f.transport.close();
    expect(f.transport.levels?.()).toEqual({ input: 0, output: 0 });
  });
});
