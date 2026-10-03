import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { runThreadGoalMutation } from "@t3tools/client-runtime/state/thread-goal-editor";
import { describe, expect, it } from "vite-plus/test";

describe("mobile thread goal mutation exclusion", () => {
  it("serializes writes to one thread without blocking another thread", async () => {
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    let release: () => void = () => undefined;
    const first = runThreadGoalMutation({ environmentId, threadId }, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "saved";
    });

    expect(
      await runThreadGoalMutation({ environmentId, threadId }, async () => "duplicate"),
    ).toEqual({ status: "busy" });
    expect(
      await runThreadGoalMutation(
        { environmentId, threadId: ThreadId.make("thread-2") },
        async () => "other",
      ),
    ).toEqual({ status: "completed", value: "other" });

    release();
    await expect(first).resolves.toEqual({ status: "completed", value: "saved" });
  });
});
