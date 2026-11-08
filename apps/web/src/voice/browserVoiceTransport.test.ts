import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createBrowserVoiceTransport } from "./browserVoiceTransport";

function fixture(
  contextState: AudioContextState = "running",
  tapKeywords = false,
  keywordsOn = true,
  { speakerSelectable = false, microphoneId = "" } = {},
) {
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
  const makeSource = () => {
    const made = {
      targets: new Set<Target>(),
      connect: vi.fn((target: Target) => {
        made.targets.add(target);
      }),
      disconnect: vi.fn((target?: Target) => {
        if (target === undefined) made.targets.clear();
        else made.targets.delete(target);
      }),
    };
    return made;
  };
  // One source per captured microphone stream, in capture order; `source` is the first.
  const sources = [makeSource()];
  const source = sources[0]!;
  const captureOn = (from: ReturnType<typeof makeSource>, frame: string) => {
    for (const target of from.targets) target.receive(frame);
  };
  const captureFrame = (frame: string) => captureOn(source, frame);
  const heardByKeywords: string[] = [];
  const keywordTap = { receive: (frame: string) => heardByKeywords.push(frame) };
  const taps = { live: 0 };
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
    createMediaStreamSource = (stream: object) => {
      if ("id" in stream) return { connect: () => {} };
      if (stream === micStream) return source;
      sources.push(makeSource());
      return sources.at(-1)!;
    };
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
  const setSinkId = vi.fn(async (_deviceId: string) => {});
  const audio = Object.assign(
    new EventTarget(),
    {
      autoplay: false,
      srcObject: null,
      play: vi.fn(async () => {}),
      pause: vi.fn(),
      remove: vi.fn(),
    },
    speakerSelectable ? { setSinkId } : {},
  );
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
    // The detector taps the newest microphone source.
    tapKeywords
      ? async () => {
          const tapped = sources.at(-1)!;
          tapped.connect(keywordTap);
          taps.live += 1;
          let detached = false;
          return () => {
            if (detached) return;
            detached = true;
            taps.live -= 1;
            tapped.disconnect(keywordTap);
          };
        }
      : undefined,
    keywordsOn,
    () => microphoneId,
  );
  const track = new Track();
  const stream = { getTracks: () => [track] };
  const micStream = stream;
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
    sources,
    taps,
    captureOn,
    setSinkId,
    newMicrophone: () => {
      const next = new Track();
      return { track: next, stream: { getTracks: () => [next] } };
    },
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

describe("browser voice live keywords", () => {
  it("attaches and detaches the keyword tap mid-call without touching the gate", async () => {
    const f = fixture("running", true, false);
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    f.transport.enableMicrophone();
    f.captureFrame("A");
    f.transport.setKeywords?.(true);
    await Promise.resolve();
    f.captureFrame("B");
    f.transport.setKeywords?.(false);
    f.captureFrame("C");
    f.transport.setKeywords?.(true);
    await Promise.resolve();
    f.transport.close();
    f.captureFrame("D");
    expect(f.heardByKeywords).toEqual(["B"]);
    expect(f.sent).toEqual(["A", "B", "C"]);
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

describe("browser voice audio devices", () => {
  async function live(options: Parameters<typeof fixture>[3] = {}) {
    const f = fixture("running", true, true, options);
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    return f;
  }
  async function switchTo(f: Awaited<ReturnType<typeof live>>, deviceId: string) {
    const next = f.newMicrophone();
    f.devices.getUserMedia.mockImplementationOnce(async () => next.stream);
    await f.transport.setMicrophone(deviceId);
    return { ...next, source: f.sources.at(-1)! };
  }

  it("swaps the microphone behind an open gate and moves the keyword tap with it", async () => {
    const f = await live();
    f.transport.enableMicrophone();
    await Promise.resolve();
    expect(f.taps.live).toBe(1);
    const next = await switchTo(f, "usb");
    await Promise.resolve();
    expect(f.taps.live).toBe(1);
    expect(f.devices.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: "usb" } },
    });
    f.captureFrame("old");
    f.captureOn(next.source, "new");
    expect(f.sent).toEqual(["new"]);
    expect(f.heardByKeywords).toEqual(["new"]);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(next.track.enabled).toBe(true);
    expect(f.silence.feeds).toBe(1);
    // The old device's loss no longer concerns the call; the new one's does.
    f.track.dispatchEvent(new Event("ended"));
    expect(f.failed).not.toHaveBeenCalled();
    next.track.dispatchEvent(new Event("ended"));
    expect(f.failed).toHaveBeenCalledOnce();
  });

  it("never opens a shut or muted gate when switching, and does nothing once closed", async () => {
    const f = await live();
    const connecting = await switchTo(f, "usb");
    f.captureOn(connecting.source, "before-approval");
    expect(connecting.track.enabled).toBe(false);
    f.transport.enableMicrophone();
    f.transport.setMicMuted?.(true);
    const muted = await switchTo(f, "studio");
    f.captureOn(muted.source, "while-muted");
    expect(f.sent).toEqual([]);
    expect(f.heardByKeywords).toEqual(["before-approval", "while-muted"]);
    f.transport.setMicMuted?.(false);
    f.captureOn(muted.source, "unmuted");
    expect(f.sent).toEqual(["unmuted"]);
    // Paused or stopped, the call is closed: a choice is saved for the next call, not captured.
    f.transport.close();
    const calls = f.devices.getUserMedia.mock.calls.length;
    await f.transport.setMicrophone("usb");
    expect(f.devices.getUserMedia).toHaveBeenCalledTimes(calls);
  });

  it("keeps the call on the current microphone when the new one cannot be captured", async () => {
    const f = await live();
    f.transport.enableMicrophone();
    f.devices.getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException("Could not start audio source", "NotReadableError");
    });
    await expect(f.transport.setMicrophone("busy")).rejects.toThrow("Could not start");
    f.captureFrame("still-old");
    expect(f.sent).toEqual(["still-old"]);
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.failed).not.toHaveBeenCalled();
  });

  it("keeps the call when another device is added or removed", async () => {
    const f = await live();
    f.transport.enableMicrophone();
    f.devices.dispatchEvent(new Event("devicechange"));
    f.captureFrame("after-change");
    expect(f.sent).toEqual(["after-change"]);
    expect(f.failed).not.toHaveBeenCalled();
  });

  it("captures a saved microphone, or the system default once it is gone", async () => {
    const f = fixture("running", false, true, { microphoneId: "gone" });
    f.devices.getUserMedia.mockImplementationOnce(async () => {
      throw new DOMException("No such device", "OverconstrainedError");
    });
    const pending = f.transport.acquireMicrophone();
    f.grant(f.stream);
    await pending;
    expect(f.devices.getUserMedia.mock.calls).toEqual([
      [{ audio: { deviceId: { exact: "gone" } } }],
      [{ audio: true }],
    ]);
  });

  it("routes playback with setSinkId where supported and reports when it is not", async () => {
    const supported = await live({ speakerSelectable: true });
    await expect(supported.transport.setSpeaker("headphones")).resolves.toBe(true);
    expect(supported.setSinkId).toHaveBeenCalledExactlyOnceWith("headphones");
    supported.transport.close();
    vi.unstubAllGlobals();
    const unsupported = await live();
    await expect(unsupported.transport.setSpeaker("headphones")).resolves.toBe(false);
    expect(unsupported.setSinkId).not.toHaveBeenCalled();
  });
});
