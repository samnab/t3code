import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import {
  ProviderEvent,
  ProviderExecutionGoalGetResult,
  ProviderExecutionGoalSnapshot,
  ProviderExecutionGoalError,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "./provider.ts";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);
const decodeProviderSession = Schema.decodeUnknownSync(ProviderSession);
const decodeProviderEvent = Schema.decodeUnknownSync(ProviderEvent);
const decodeProviderUploadFeedbackInput = Schema.decodeUnknownSync(ProviderUploadFeedbackInput);
const decodeProviderUploadFeedbackResult = Schema.decodeUnknownSync(ProviderUploadFeedbackResult);
const decodeExecutionGoalSnapshot = Schema.decodeUnknownSync(ProviderExecutionGoalSnapshot);
const decodeExecutionGoalGetResult = Schema.decodeUnknownSync(ProviderExecutionGoalGetResult);
const decodeExecutionGoalError = Schema.decodeUnknownSync(ProviderExecutionGoalError);

function getOptionValue(
  options: ReadonlyArray<{ id: string; value: unknown }> | undefined,
  id: string,
): unknown {
  return options?.find((option) => option.id === id)?.value;
}

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
      runtimeMode: "full-access",
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelSelection?.instanceId).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    expect(getOptionValue(parsed.modelSelection?.options, "reasoningEffort")).toBe("high");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts claude runtime knobs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [
          { id: "thinking", value: true },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ],
      },
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.instanceId).toBe("claudeAgent");
    expect(parsed.modelSelection?.model).toBe("claude-sonnet-4-6");
    expect(getOptionValue(parsed.modelSelection?.options, "thinking")).toBe(true);
    expect(getOptionValue(parsed.modelSelection?.options, "effort")).toBe("max");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
    expect(parsed.runtimeMode).toBe("full-access");
  });

  it("accepts cursor provider", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "cursor",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        provider: "cursor",
        model: "composer-2",
        options: [{ id: "fastMode", value: true }],
      },
    });
    expect(parsed.provider).toBe("cursor");
    expect(parsed.modelSelection?.instanceId).toBe("cursor");
    expect(parsed.modelSelection?.model).toBe("composer-2");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: "ollama_local",
        model: "llama3.3",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
    expect(parsed.modelSelection?.instanceId).toBe("ollama_local");
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts codex modelSelection", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: [
          { id: "reasoningEffort", value: "xhigh" },
          { id: "fastMode", value: true },
        ],
      },
    });

    expect(parsed.modelSelection?.instanceId).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    expect(getOptionValue(parsed.modelSelection?.options, "reasoningEffort")).toBe("xhigh");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });

  it("accepts claude modelSelection including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [
          { id: "effort", value: "ultrathink" },
          { id: "fastMode", value: true },
        ],
      },
    });

    expect(parsed.modelSelection?.instanceId).toBe("claudeAgent");
    expect(getOptionValue(parsed.modelSelection?.options, "effort")).toBe("ultrathink");
    expect(getOptionValue(parsed.modelSelection?.options, "fastMode")).toBe(true);
  });
});

describe("provider feedback", () => {
  it("accepts a thread and an optional feedback reason", () => {
    expect(
      decodeProviderUploadFeedbackInput({
        threadId: "thread-1",
        reason: "The agent stopped early.",
      }),
    ).toEqual({ threadId: "thread-1", reason: "The agent stopped early." });
    expect(decodeProviderUploadFeedbackInput({ threadId: "thread-1" })).toEqual({
      threadId: "thread-1",
    });
  });

  it("returns the shareable Codex feedback identifier", () => {
    expect(decodeProviderUploadFeedbackResult({ feedbackId: "provider-thread-1" })).toEqual({
      feedbackId: "provider-thread-1",
    });
  });

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

describe("providerInstanceId routing key (slice-2 invariant)", () => {
  it("decodes a ProviderSessionStartInput without providerInstanceId (legacy producer)", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      runtimeMode: "full-access",
    });
    expect(parsed.providerInstanceId).toBeUndefined();
  });

  it("decodes a ProviderSessionStartInput with providerInstanceId (post-migration producer)", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      providerInstanceId: "codex_personal",
      runtimeMode: "full-access",
    });
    expect(parsed.providerInstanceId).toBe("codex_personal");
  });

  it("propagates providerInstanceId through ProviderSession decode", () => {
    const session = decodeProviderSession({
      provider: "codex",
      providerInstanceId: "codex_work",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "thread-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(session.providerInstanceId).toBe("codex_work");
  });

  it("decodes ProviderSession for fork-provided driver kinds", () => {
    const session = decodeProviderSession({
      provider: "ollama",
      providerInstanceId: "ollama_local",
      status: "ready",
      runtimeMode: "full-access",
      threadId: "thread-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });

    expect(session.provider).toBe("ollama");
    expect(session.providerInstanceId).toBe("ollama_local");
  });

  it("decodes a ProviderEvent carrying both legacy provider and new instance routing", () => {
    const event = decodeProviderEvent({
      id: "event-1",
      kind: "notification",
      provider: "codex",
      providerInstanceId: "codex_personal",
      threadId: "thread-1",
      createdAt: "2024-01-01T00:00:00Z",
      method: "session.created",
    });
    expect(event.provider).toBe("codex");
    expect(event.providerInstanceId).toBe("codex_personal");
  });

  it("rejects providerInstanceId values that fail the slug pattern (defense in depth)", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerInstanceId: "1bad",
        runtimeMode: "full-access",
      }),
    ).toThrow();
  });
});

describe("ProviderExecutionGoalSnapshot", () => {
  const goalSnapshot = {
    threadId: "thread-1",
    objective: "ship the login fix",
    status: "usageLimited",
    tokensUsed: 12345,
    tokenBudget: null,
    timeUsedSeconds: 200,
    createdAt: "2026-04-15T17:00:00.000Z",
    updatedAt: "2026-04-15T17:01:00.000Z",
  };

  it("accepts every Codex status literally", () => {
    for (const status of [
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ]) {
      expect(decodeExecutionGoalSnapshot({ ...goalSnapshot, status }).status).toBe(status);
    }
  });

  it("keeps an absent tokenBudget absent and a null one null", () => {
    const { tokenBudget: _omitted, ...withoutBudget } = goalSnapshot;
    expect(decodeExecutionGoalSnapshot(withoutBudget).tokenBudget).toBeUndefined();
    expect(decodeExecutionGoalSnapshot(goalSnapshot).tokenBudget).toBeNull();
  });

  it("rejects an unknown status so provider vocabulary cannot drift silently", () => {
    expect(() => decodeExecutionGoalSnapshot({ ...goalSnapshot, status: "expired" })).toThrow();
  });

  it("decodes a null goal result and the typed error reason", () => {
    expect(decodeExecutionGoalGetResult({ goal: null }).goal).toBeNull();
    const error = decodeExecutionGoalError({
      _tag: "ProviderExecutionGoalError",
      threadId: "thread-1",
      reason: "no-live-session",
      message: "Unknown codex adapter thread: thread-1",
    });
    expect(error.reason).toBe("no-live-session");
    expect(error.threadId).toBe("thread-1");
  });
});
