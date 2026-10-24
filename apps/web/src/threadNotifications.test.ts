import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const SOUND_SECONDS = 0.6;

const audio = { currentTime: 0, started: 0, gain: 1 };

class FakeAudioContext {
  state = "running";
  destination = {};
  get currentTime() {
    return audio.currentTime;
  }
  resume() {
    return Promise.resolve();
  }
  decodeAudioData() {
    return Promise.resolve({ duration: SOUND_SECONDS });
  }
  createGain() {
    return {
      gain: {
        set value(value: number) {
          audio.gain = value;
        },
      },
      connect() {},
    };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        audio.started += 1;
      },
    };
  }
}

async function loadUnlocked() {
  const notifications = await import("./threadNotifications");
  notifications.unlockNotificationAudio();
  return notifications;
}

beforeEach(() => {
  vi.resetModules();
  audio.currentTime = 0;
  audio.started = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(0) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playNotificationSound", () => {
  it("plays one sound for threads that complete together", async () => {
    const { playNotificationSound } = await loadUnlocked();

    // All four are waiting on the first decode when the sound becomes playable.
    await Promise.all(
      Array.from({ length: 4 }, () => playNotificationSound("completion", () => true)),
    );

    expect(audio.started).toBe(1);
  });

  it("still plays an input alert over a completion sound", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => true);

    await playNotificationSound("input", () => true);

    expect(audio.started).toBe(2);
  });

  it("leaves the slot free when a sound is turned off before it plays", async () => {
    const { playNotificationSound } = await loadUnlocked();
    await playNotificationSound("completion", () => false);

    await playNotificationSound("completion", () => true);

    expect(audio.started).toBe(1);
  });
});

it("does not double-deliver a capable Voice completion through the device chime", async () => {
  const { shouldPlayThreadSound } = await import("./threadNotifications");
  expect(
    shouldPlayThreadSound({
      kind: "completion",
      mode: "sound",
      completionAudio: "voice",
      supportsCompletionAudio: true,
      isChild: false,
    }),
  ).toBe(false);
});

it("uses one completion slot across tones while leaving input independent", async () => {
  const { playNotificationSound } = await loadUnlocked();
  await playNotificationSound("completion", () => true, { tone: "completion", volume: 0.25 });
  expect(audio.gain).toBe(0.25);
  expect(await playNotificationSound("completion", () => true, { tone: "input" })).toBe(false);
  expect(await playNotificationSound("input", () => true, { tone: "completion" })).toBe(true);
  expect(audio.started).toBe(2);
});

it("rechecks an Off choice after asynchronous decode and leaves the slot free", async () => {
  let finishDecode: ((value: { duration: number }) => void) | undefined;
  const decoded = new Promise<{ duration: number }>((resolve) => {
    finishDecode = resolve;
  });
  using _decode = vi
    .spyOn(FakeAudioContext.prototype, "decodeAudioData")
    .mockImplementation(() => decoded);
  const { playNotificationSound } = await loadUnlocked();
  let enabled = true;
  const pending = playNotificationSound("completion", () => enabled);
  enabled = false;
  finishDecode?.({ duration: SOUND_SECONDS });
  expect(await pending).toBe(false);
  expect(audio.started).toBe(0);
  expect(await playNotificationSound("completion", () => true)).toBe(true);
});

it.each([
  ["off", "sound", false, false],
  ["voice", "sound", false, false],
  ["sound", "off", false, true],
  ["sound", "off", true, true],
] as const)(
  "uses canonical %s rather than device %s for a capable completion",
  async (completionAudio, mode, isChild, expected) => {
    const { shouldPlayThreadSound } = await import("./threadNotifications");
    expect(
      shouldPlayThreadSound({
        kind: "completion",
        mode,
        completionAudio,
        supportsCompletionAudio: true,
        isChild,
      }),
    ).toBe(expected);
  },
);

it("previews only on an explicit call using the same inert player and saved gain", async () => {
  const { previewCompletionSound } = await import("./threadNotifications");
  expect(audio.started).toBe(0);
  expect(await previewCompletionSound("input", 0.6)).toBe(true);
  expect(audio.started).toBe(1);
  expect(audio.gain).toBe(0.6);
});
