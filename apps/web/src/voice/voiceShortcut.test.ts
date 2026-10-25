import { describe, expect, it } from "vite-plus/test";
import { voiceShortcutAction } from "./voiceShortcut";

describe("voice shortcut authority", () => {
  it("lets forwarded or untrusted input pause and turn the microphone off but never resume", () => {
    expect(voiceShortcutAction("transmitting", "voice.togglePause", false)).toBe("pause");
    expect(voiceShortcutAction("connecting", "voice.togglePause", false)).toBe("pause");
    expect(voiceShortcutAction("paused", "voice.micOff", false)).toBe("end");
    expect(voiceShortcutAction("paused", "voice.togglePause", false)).toBeNull();
    expect(voiceShortcutAction("paused", "voice.togglePause", true)).toBe("resume");
    expect(voiceShortcutAction("off", "voice.togglePause", true)).toBeNull();
  });
});
