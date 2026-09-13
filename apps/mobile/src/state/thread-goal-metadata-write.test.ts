import { describe, expect, it } from "vite-plus/test";

import {
  COMMAND_GOAL_WRITE,
  canClaimThreadGoalMetadataWrite,
  canRunThreadGoalLoopAction,
  canStartThreadGoalCommandWrite,
} from "./thread-goal-metadata-write";

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

describe("thread goal delete exclusion", () => {
  it("blocks typed goal commands while a delete is in flight", () => {
    expect(canStartThreadGoalCommandWrite(null, false)).toBe(true);
    expect(canStartThreadGoalCommandWrite(1, false)).toBe(false);
    expect(canStartThreadGoalCommandWrite(null, true)).toBe(false);
  });

  it("blocks goal loop actions while a delete is in flight", () => {
    expect(canRunThreadGoalLoopAction(false)).toBe(true);
    expect(canRunThreadGoalLoopAction(true)).toBe(false);
  });
});
