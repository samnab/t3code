import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadDetailToShell } from "./thread-selection";

const environmentId = EnvironmentId.make("environment-1");
const thread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  voiceNotifications: true,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
} satisfies OrchestrationThread;

describe("threadDetailToShell", () => {
  it("preserves set, cleared, and omitted goal states", () => {
    expect(threadDetailToShell(environmentId, { ...thread, goal: "Ship it" }).goal).toBe("Ship it");
    expect(threadDetailToShell(environmentId, { ...thread, goal: null }).goal).toBeNull();
    expect("goal" in threadDetailToShell(environmentId, thread)).toBe(false);
  });

  it("skips server-authored origin messages when finding the latest user message", () => {
    const withOriginOnly = {
      ...thread,
      messages: [
        {
          id: MessageId.make("m1"),
          role: "user",
          text: "[T3 subagent result: Title (codex/gpt, done, run r1)]\nbody",
          turnId: null,
          streaming: false,
          origin: "subagent-delivery",
          createdAt: "2026-04-02T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
      ],
    } satisfies OrchestrationThread;

    expect(threadDetailToShell(environmentId, withOriginOnly).latestUserMessageAt).toBeNull();
  });
});
