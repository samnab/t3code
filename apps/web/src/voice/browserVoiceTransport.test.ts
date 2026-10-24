import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createBrowserVoiceTransport } from "./browserVoiceTransport";

function fixture() {
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
  const audio = Object.assign(new EventTarget(), {
    autoplay: false,
    srcObject: null,
    pause: vi.fn(),
    remove: vi.fn(),
  });
  const devices = Object.assign(new EventTarget(), { getUserMedia: vi.fn(() => permission) });
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("document", { createElement: () => audio });
  vi.stubGlobal("navigator", { mediaDevices: devices });
  const failed = vi.fn();
  const transport = createBrowserVoiceTransport({ connected: vi.fn(), failed });
  const track = new Track();
  const stream = { getTracks: () => [track] };
  return { transport, track, stream, grant, addTrack, closePeer, channel, audio, devices, failed };
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
    f.track.dispatchEvent(new Event("ended"));
    f.devices.dispatchEvent(new Event("devicechange"));
    expect(f.failed).not.toHaveBeenCalled();
  });
});
