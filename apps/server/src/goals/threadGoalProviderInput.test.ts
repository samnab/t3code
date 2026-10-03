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

it("does not inject a completed goal into a later user turn", () => {
  expect(
    injectThreadGoal("Start unrelated work", {
      goal: "Ship the goal loop",
      goalLoop: {
        state: "completed",
        mode: "t3",
        iterations: 3,
        maxIterations: 10,
        updatedAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
      },
    }),
  ).toBe("Start unrelated work");
});

for (const state of ["running", "completed"] as const) {
  it(`leaves native maintenance commands bare for a ${state} goal`, () => {
    const thread = {
      goal: "Ship the goal loop",
      goalLoop: {
        state,
        mode: "t3" as const,
        iterations: 2,
        maxIterations: 10,
        updatedAt: DateTime.makeUnsafe("2026-10-02T12:00:00.000Z"),
      },
    };

    expect(injectThreadGoal(" /COMPACT ", thread)).toBe(" /COMPACT ");
    expect(injectThreadGoal("/logout", thread)).toBe("/logout");
    expect(
      injectThreadGoal("<composer_context>ignored</composer_context>\n\n/compact", thread, {
        text: "/compact",
        attachments: [],
      }),
    ).toBe("/compact");
  });
}
