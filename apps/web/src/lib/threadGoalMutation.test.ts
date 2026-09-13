import { deleteThreadGoalWork } from "@t3tools/client-runtime/state/threadGoalEditor";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runThreadGoalMutation } from "./threadGoalMutation";

const threadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runThreadGoalMutation", () => {
  it("holds one thread slot across a deferred delete sequence", async () => {
    const pause = deferred();
    const pauseStarted = deferred();
    const steps: string[] = [];

    const deleting = runThreadGoalMutation(threadRef, () =>
      deleteThreadGoalWork({
        loop: {
          kind: "standard",
          state: "running",
          mode: "t3",
          iterations: 1,
          maxIterations: 10,
          reason: null,
          experiment: null,
          updatedAt: "2026-09-07T02:00:00.000Z",
        },
        pauseGoalLoop: async () => {
          steps.push("pause");
          pauseStarted.resolve();
          await pause.promise;
          return true;
        },
        interruptActiveTurn: async () => {
          steps.push("interrupt");
          return true;
        },
        clearGoal: async () => {
          steps.push("clear");
          return true;
        },
      }),
    );

    await pauseStarted.promise;
    let setCalled = false;
    let resumeCalled = false;
    let secondDeleteCalled = false;
    const concurrentSet = await runThreadGoalMutation(threadRef, async () => {
      setCalled = true;
    });
    const concurrentResume = await runThreadGoalMutation(threadRef, async () => {
      resumeCalled = true;
    });
    const secondDelete = await runThreadGoalMutation(threadRef, async () => {
      secondDeleteCalled = true;
    });

    expect(concurrentSet).toEqual({ status: "busy" });
    expect(concurrentResume).toEqual({ status: "busy" });
    expect(secondDelete).toEqual({ status: "busy" });
    expect(setCalled).toBe(false);
    expect(resumeCalled).toBe(false);
    expect(secondDeleteCalled).toBe(false);

    pause.resolve();
    await expect(deleting).resolves.toEqual({ status: "completed", value: "stopped" });
    expect(steps).toEqual(["pause", "interrupt", "clear"]);
  });

  it("releases the slot after success and failure", async () => {
    await expect(runThreadGoalMutation(threadRef, async () => "saved")).resolves.toEqual({
      status: "completed",
      value: "saved",
    });
    await expect(
      runThreadGoalMutation(threadRef, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(runThreadGoalMutation(threadRef, async () => "retried")).resolves.toEqual({
      status: "completed",
      value: "retried",
    });
  });

  it("allows different threads to mutate independently", async () => {
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const first = runThreadGoalMutation(threadRef, async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    await expect(
      runThreadGoalMutation(
        { ...threadRef, threadId: ThreadId.make("thread-b") },
        async () => "saved",
      ),
    ).resolves.toEqual({ status: "completed", value: "saved" });

    releaseFirst.resolve();
    await first;
  });
});
