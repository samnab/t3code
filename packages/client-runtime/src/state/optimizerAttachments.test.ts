import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { latestOptimizerAttachmentForSession } from "./optimizerAttachments.ts";

function activity(
  id: string,
  session: { readonly providerInstanceId: string; readonly createdAt: string },
  payload: Record<string, unknown>,
  sequence: number,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "optimizer_attached",
    summary: "Session optimizers updated",
    payload: { session, ...payload },
    turnId: null,
    sequence,
    createdAt: session.createdAt,
  };
}

describe("latestOptimizerAttachmentForSession", () => {
  it("uses the latest authoritative event and clears an older session state", () => {
    const currentSession = { providerInstanceId: "provider-current" };
    const result = latestOptimizerAttachmentForSession(
      [
        activity(
          "old-session",
          { providerInstanceId: "provider-old", createdAt: "2026-09-09T00:00:01.000Z" },
          { configured: ["cbm"], attached: ["cbm"], ready: ["cbm"] },
          1,
        ),
        activity(
          "current-session",
          { providerInstanceId: "provider-current", createdAt: "2026-09-09T00:00:02.000Z" },
          { configured: ["rtk"], attached: ["rtk"], ready: ["rtk"] },
          2,
        ),
        activity(
          "current-session-cleared",
          { providerInstanceId: "provider-current", createdAt: "2026-09-09T00:00:03.000Z" },
          { configured: [], attached: [], ready: [] },
          3,
        ),
      ],
      currentSession,
    );

    expect(result).toEqual({
      providerInstanceId: "provider-current",
      createdAt: "2026-09-09T00:00:03.000Z",
      configured: [],
      attached: [],
      ready: [],
    });
  });

  it("matches the event creation identity when the caller has it", () => {
    const result = latestOptimizerAttachmentForSession(
      [
        activity(
          "session-a",
          { providerInstanceId: "provider", createdAt: "2026-09-09T00:00:01.000Z" },
          { configured: ["rtk"], attached: ["rtk"], ready: ["rtk"] },
          1,
        ),
        activity(
          "session-b",
          { providerInstanceId: "provider", createdAt: "2026-09-09T00:00:02.000Z" },
          { configured: ["headroom"], attached: ["headroom"], ready: ["headroom"] },
          2,
        ),
      ],
      { providerInstanceId: "provider", createdAt: "2026-09-09T00:00:01.000Z" },
    );

    expect(result?.attached).toEqual(["rtk"]);
  });

  it("ignores malformed attachment payloads", () => {
    const malformed = {
      id: EventId.make("malformed"),
      tone: "info" as const,
      kind: "optimizer_attached",
      summary: "Session optimizers updated",
      payload: { session: { providerInstanceId: "provider" } },
      turnId: null,
      createdAt: "2026-09-09T00:00:01.000Z",
    } satisfies OrchestrationThreadActivity;

    expect(
      latestOptimizerAttachmentForSession([malformed], { providerInstanceId: "provider" }),
    ).toBeNull();
  });
});
