import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import { canStopThreadBackgroundTask, deriveThreadBackgroundWork } from "./threadBackgroundWork.ts";

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

describe("deriveThreadBackgroundWork", () => {
  const settledRun = { id: "run-1", ordinal: 1, status: "completed" } as never;
  const backgroundCommand = (id: string) =>
    ({
      id,
      type: "command_execution",
      status: "running",
      title: id,
      nativeItemRef: { nativeId: id },
      input: id,
    }) as never;

  it("lists the newest background process first", () => {
    const work = deriveThreadBackgroundWork({
      ...v2Projection,
      runs: [settledRun],
      turnItems: [backgroundCommand("older"), backgroundCommand("newer")],
    });

    expect(work.map((entry) => entry.task.taskId)).toEqual(["newer", "older"]);
  });

  it("keeps pending rows in place as newer work arrives", () => {
    const first = deriveThreadBackgroundWork({
      ...v2Projection,
      runs: [settledRun],
      turnItems: [backgroundCommand("older")],
    });
    const second = deriveThreadBackgroundWork({
      ...v2Projection,
      runs: [settledRun],
      turnItems: [backgroundCommand("older"), backgroundCommand("newer")],
    });

    expect(first.map((entry) => entry.task.taskId)).toEqual(["older"]);
    expect(second.map((entry) => entry.task.taskId).slice(1)).toEqual(["older"]);
  });
});
