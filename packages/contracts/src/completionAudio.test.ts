import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CompletionAudioListInput,
  CompletionAudioReadInput,
  CompletionAudioSetInput,
  CompletionAudioBulkOffInput,
  CompletionAudioBulkOffResult,
  resolveCompletionAudio,
  readStoredCompletionAudio,
  completionAudioCreationFields,
} from "./completionAudio.ts";

const decodeRead = Schema.decodeUnknownSync(CompletionAudioReadInput);
const decodeBulkResult = Schema.decodeUnknownSync(CompletionAudioBulkOffResult);

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

describe("completion audio API boundaries", () => {
  it("bounds live offset pages and rejects ambiguous read targets", () => {
    const list = Schema.decodeUnknownSync(CompletionAudioListInput);
    expect(list({ cursor: 0, limit: 100 })).toEqual({ cursor: 0, limit: 100 });
    for (const input of [{ cursor: -1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }])
      expect(() => list(input)).toThrow();
    expect(() =>
      decodeRead({
        threadId: "thread",
        projectId: "project",
      }),
    ).toThrow();
  });
  it("requires valid bounded retry keys and rejects malformed bulk outcomes", () => {
    const set = Schema.decodeUnknownSync(CompletionAudioSetInput);
    const bulk = Schema.decodeUnknownSync(CompletionAudioBulkOffInput);
    for (const clientRequestId of ["", "x".repeat(257), "\ud800"]) {
      expect(() => set({ threadId: "thread", mode: "sound", clientRequestId })).toThrow();
      expect(() => bulk({ clientRequestId })).toThrow();
    }
    expect(() =>
      decodeBulkResult({
        environmentId: "environment",
        total: 101,
        turnedOff: 0,
        alreadyOff: 0,
        failedCount: 101,
        failed: Array.from({ length: 101 }, () => ({ threadId: "thread", reason: "failed" })),
        failuresTruncated: false,
        complete: true,
      }),
    ).toThrow();
  });
});

it.each([
  [{ completionAudio: "sound", voiceNotifications: true }, "sound"],
  [{ voiceNotifications: true }, "voice"],
  [{ voiceNotifications: false }, "off"],
  [{}, null],
  [{ completionAudio: "invalid", voiceNotifications: false }, "off"],
  [{ completionAudio: "invalid" }, null],
] as const)("preserves canonical/legacy/untouched draft semantics for %j", (stored, mode) => {
  expect(readStoredCompletionAudio(stored)).toBe(mode);
  expect(completionAudioCreationFields(readStoredCompletionAudio(stored))).toEqual(
    mode === null ? {} : { completionAudio: mode, voiceNotifications: mode === "voice" },
  );
});
