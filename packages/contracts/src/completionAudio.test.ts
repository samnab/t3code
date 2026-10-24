import { describe, expect, it } from "vite-plus/test";
import { resolveCompletionAudio } from "./completionAudio.ts";

describe("resolveCompletionAudio", () => {
  it("derives old booleans only when the mode is absent", () => {
    expect(resolveCompletionAudio({})).toBe("off");
    expect(resolveCompletionAudio({ voiceNotifications: false })).toBe("off");
    expect(resolveCompletionAudio({ voiceNotifications: true })).toBe("voice");
    expect(resolveCompletionAudio({ completionAudio: "off", voiceNotifications: true })).toBe(
      "off",
    );
    expect(resolveCompletionAudio({ completionAudio: "sound", voiceNotifications: true })).toBe(
      "sound",
    );
    expect(resolveCompletionAudio({ completionAudio: "voice", voiceNotifications: false })).toBe(
      "voice",
    );
  });
});
