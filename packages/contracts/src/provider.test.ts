import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import {
  ProviderRealtimeVoiceStartInput,
  ProviderRealtimeVoiceStartResult,
  ProviderRealtimeVoiceStopInput,
  ProviderSendTurnInput,
  ProviderUploadFeedbackError,
} from "./provider.ts";

const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSendTurnInput", () => {
  it.each(["image", "file"])(
    "caps total image bytes for %s attachments without charging videos",
    (type) => {
      const image = {
        type,
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 10 * 1024 * 1024,
      };
      const video = {
        type: "file",
        id: "video",
        name: "video.mp4",
        mimeType: "video/mp4",
        sizeBytes: 50 * 1024 * 1024,
      };
      expect(
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), video],
        }).attachments,
      ).toHaveLength(9);
      expect(() =>
        decodeProviderSendTurnInput({
          threadId: "thread-1",
          attachments: [...Array.from({ length: 8 }, () => image), { ...image, sizeBytes: 1 }],
        }),
      ).toThrow(/80 MiB/);
    },
  );
});

describe("provider feedback", () => {
  it("keeps the failed thread and original cause without exposing upstream text", () => {
    const cause = new Error("provider request secret");
    const error = new ProviderUploadFeedbackError({
      threadId: ThreadId.make("thread-1"),
      cause,
    });

    expect(error.threadId).toBe("thread-1");
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("Failed to upload feedback for thread thread-1.");
    expect(error.message).not.toContain("provider request secret");
  });
});

const decodeVoiceStart = Schema.decodeUnknownSync(ProviderRealtimeVoiceStartInput);
const decodeVoiceResult = Schema.decodeUnknownSync(ProviderRealtimeVoiceStartResult);
const decodeVoiceStop = Schema.decodeUnknownSync(ProviderRealtimeVoiceStopInput);

it("preserves explicit voice ownership alongside legacy payloads and verbatim SDP", () => {
  const sdp = "offer\r\n";
  expect(decodeVoiceStart({ threadId: "thread", sdp })).toEqual({ threadId: "thread", sdp });
  expect(decodeVoiceStart({ threadId: "thread", sdp, operationId: "owner-a" }).operationId).toBe(
    "owner-a",
  );
  expect(() => decodeVoiceStart({ threadId: "thread", sdp, operationId: " " })).toThrow();
  expect(decodeVoiceStop({ threadId: "thread" })).toEqual({ threadId: "thread" });
  const ownership = {
    operationId: "owner-a",
    voiceSessionToken: "token-a",
    providerSessionId: "session-a",
    providerThreadId: "provider-thread-a",
  };
  expect(decodeVoiceStop({ threadId: "thread", ...ownership })).toEqual({
    threadId: "thread",
    ...ownership,
  });
  expect(
    decodeVoiceResult({
      sdp,
      ...ownership,
      providerInstanceId: "codex",
      expiresAt: "2026-10-24T05:00:00.000Z",
    }).voiceSessionToken,
  ).toBe("token-a");
});
