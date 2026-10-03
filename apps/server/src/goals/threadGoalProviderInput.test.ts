import { expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { injectThreadGoal } from "./threadGoalProviderInput.ts";

it("prepends an active T3 goal to provider input", () => {
  const text = injectThreadGoal("Implement the next step", {
    goal: "Ship the goal loop",
    goalLoop: {
      state: "running",
      mode: "t3",
      iterations: 2,
      maxIterations: 10,
      updatedAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
    },
  });

  expect(text).toContain(
    '<thread_goal iteration="2" max="10">\nShip the goal loop\n</thread_goal>',
  );
  expect(text.endsWith("\n\nImplement the next step")).toBe(true);
});

it("leaves input unchanged without a T3-managed goal", () => {
  expect(injectThreadGoal("Hello", { goal: null, goalLoop: null })).toBe("Hello");
});
