import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { VoiceAudioDevices } from "./VoiceAudioDevices";

// chooseAudioDevice is the only path from this menu to a capture (getUserMedia) or setSinkId.
const state = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock(import("./RealtimeVoiceProvider"), () => ({
  useRealtimeVoice: (() => ({
    snapshot: { mode: "transmitting" },
    audio: {
      microphone: "",
      speaker: "",
      inUse: { microphone: "", speaker: "" },
      switching: null,
      failed: null,
      volume: 100,
      restoreVolume: 100,
    },
    levels: () => ({ input: 0, output: 0 }),
    chooseAudioDevice: state.choose,
  })) as never,
}));

const device = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => ({
  kind,
  deviceId,
  label,
  groupId: deviceId,
  toJSON: () => ({ kind, deviceId, label }),
});

function setup() {
  state.choose.mockReset();
  return vi
    .spyOn(navigator.mediaDevices, "enumerateDevices")
    .mockResolvedValue([
      device("audioinput", "mic-builtin", "MacBook Pro Microphone"),
      device("audioinput", "mic-studio", "Studio Display Microphone"),
      device("audiooutput", "out-builtin", "MacBook Pro Speakers"),
    ]);
}

describe("VoiceAudioDevices", () => {
  it("moves through devices with arrows without choosing one, and chooses on Enter", async () => {
    using _devices = setup();
    await using screen = await render(<VoiceAudioDevices labels="" />);
    const trigger = screen.getByRole("button", { name: "Audio devices" });
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
    const studio = page.getByRole("menuitemradio", { name: "Studio Display Microphone" });
    await expect.element(studio).toBeVisible();
    // System default → MacBook Pro → Studio → Speaker's system default → back to Studio.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}");
    await expect.element(studio).toHaveFocus();
    expect(state.choose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(state.choose).toHaveBeenCalledExactlyOnceWith("microphone", "mic-studio");
  });
});
