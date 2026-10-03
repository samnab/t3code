import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canStopThreadBackgroundTask } from "./threadBackgroundWork.ts";

const task: OrchestrationV2PendingBackgroundTask = {
  taskId: "task-1",
  kind: "command",
};

describe("canStopThreadBackgroundTask", () => {
  it("requires both task listing and an explicitly stoppable task kind", () => {
    const capability: OrchestrationV2ProviderCapabilities["backgroundWork"] = {
      canListTasks: true,
      stoppableTaskKinds: ["command"],
    };

    expect(canStopThreadBackgroundTask(task, capability)).toBe(true);
    expect(canStopThreadBackgroundTask({ ...task, kind: "monitor" }, capability)).toBe(false);
    expect(canStopThreadBackgroundTask(task, { ...capability, canListTasks: false })).toBe(false);
    expect(canStopThreadBackgroundTask(task, undefined)).toBe(false);
  });
});
