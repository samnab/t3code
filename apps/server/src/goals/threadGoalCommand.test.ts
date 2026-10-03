import { expect, it } from "vite-plus/test";

import { parseThreadGoalCommand } from "./threadGoalCommand.ts";

it("recognizes goal commands using only Unicode White_Space delimiters", () => {
  expect(parseThreadGoalCommand("\u00a0/goal\tShip it\r\n")).toEqual({
    action: "set",
    goal: "Ship it",
  });
  expect(parseThreadGoalCommand("/goal clear")).toEqual({ action: "clear" });
  expect(parseThreadGoalCommand("/goal")).toEqual({ action: "show" });
});

it("does not classify zero-width joined text as a goal command", () => {
  expect(parseThreadGoalCommand("/goal\uFEFFShip it")).toBeNull();
  expect(parseThreadGoalCommand("\uFEFF/goal Ship it")).toBeNull();
  expect(parseThreadGoalCommand("What does /goal do?")).toBeNull();
});
