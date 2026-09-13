import { describe, expect, it } from "vite-plus/test";

import { COMMAND_GOAL_WRITE, canClaimThreadGoalMetadataWrite } from "./thread-goal-metadata-write";

describe("canClaimThreadGoalMetadataWrite", () => {
  it("allows an idle slot and supersedes an older editor epoch", () => {
    expect(canClaimThreadGoalMetadataWrite(null, 2)).toBe(true);
    expect(canClaimThreadGoalMetadataWrite(1, 2)).toBe(true);
  });

  it("blocks the current editor epoch and a typed goal command", () => {
    expect(canClaimThreadGoalMetadataWrite(2, 2)).toBe(false);
    expect(canClaimThreadGoalMetadataWrite(COMMAND_GOAL_WRITE, 2)).toBe(false);
  });
});
