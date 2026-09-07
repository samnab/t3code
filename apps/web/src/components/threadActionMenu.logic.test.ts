import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasReloadableSession: true,
  supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true },
  executionGoal: false,
  goalLoop: null,
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

function allIds(state: ThreadActionMenuState): string[] {
  const flatten = (items: ReturnType<typeof buildThreadActionMenuItems>): string[] =>
    items.flatMap((item) => [item.id, ...(item.children ? flatten(item.children) : [])]);
  return flatten(buildThreadActionMenuItems(state));
}

describe("buildThreadActionMenuItems", () => {
  it("hides lifecycle items when the environment lacks the capabilities", () => {
    expect(
      ids({
        ...baseState,
        supports: { settlement: false, snooze: false, pinning: false, titleRegeneration: false },
      }),
    ).toEqual([
      "rename",
      "mark-unread",
      "reload-agent",
      "copy",
      "project-settings",
      "archive",
      "delete",
    ]);
  });

  it("groups project settings with utility actions before archive", () => {
    const items = buildThreadActionMenuItems(baseState);
    const copyIndex = items.findIndex((item) => item.id === "copy");
    expect(items[copyIndex + 1]).toMatchObject({
      id: "project-settings",
      label: "Project settings",
      icon: "settings",
    });
    expect(items[copyIndex + 2]?.id).toBe("archive");
  });

  it("offers the Codex execution goal only when the thread's provider declares it", () => {
    expect(ids({ ...baseState, executionGoal: true })).toContain("execution-goal");
    // Absent capability (other providers, old servers, no live session)
    // hides the entry instead of dead-ending the click.
    expect(ids({ ...baseState })).not.toContain("execution-goal");
    const item = buildThreadActionMenuItems({ ...baseState, executionGoal: true }).find(
      (candidate) => candidate.id === "execution-goal",
    );
    // The label names Codex in full so it can never read as the T3 goal.
    expect(item?.label).toBe("Codex execution goal…");
  });

  it("includes branch items only for threads with a branch", () => {
    const withBranch = allIds({ ...baseState, branch: "feat/menu" });
    expect(withBranch).toContain("new-thread-on-branch");
    expect(withBranch).toContain("copy-branch");
    expect(allIds(baseState)).not.toContain("new-thread-on-branch");
    expect(allIds(baseState)).not.toContain("copy-branch");
  });

  it("flips lifecycle labels with thread state", () => {
    expect(ids({ ...baseState, isPinned: true, isSettled: true, isSnoozed: true })).toEqual(
      expect.arrayContaining(["unpin", "unsettle", "unsnooze"]),
    );
    expect(ids(baseState)).toEqual(expect.arrayContaining(["pin", "settle", "snooze"]));
  });

  it("disables snooze when the thread cannot snooze, keeping presets visible", () => {
    const snooze = buildThreadActionMenuItems({ ...baseState, canSnoozeNow: false }).find(
      (item) => item.id === "snooze",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour"]);
  });

  it("disables title regeneration while one is in flight", () => {
    const item = buildThreadActionMenuItems({ ...baseState, isRegeneratingTitle: true }).find(
      (candidate) => candidate.id === "regenerate-title",
    );
    expect(item).toMatchObject({ label: "Regenerating…", disabled: true });
  });

  it("does not offer resume after an experiment exhausts its campaign limits", () => {
    const items = ids({
      ...baseState,
      goalLoop: {
        kind: "experiment",
        state: "paused",
        mode: "t3",
        iterations: 4,
        maxIterations: 10,
        updatedAt: "2026-09-07T02:00:00.000Z",
        experiment: {
          runId: "run-1",
          configDigest: "sha256:config",
          phase: "exhausted",
          metric: { name: "score", direction: "maximize", minimumImprovement: 0.1 },
          experimentsRun: 4,
          experimentsKept: 1,
          experimentsRestored: 3,
          baselineMetric: 10,
          bestMetric: 11,
          lastMetric: 10.5,
          elapsedSeconds: 120,
          maxExperiments: 4,
          maxTotalSeconds: 120,
          lastError: "Time limit reached",
        },
      },
    });

    expect(items).not.toContain("resume-goal-loop");
    expect(items).not.toContain("pause-goal-loop");
  });

  it("marks delete as destructive and keeps it last", () => {
    const items = buildThreadActionMenuItems({ ...baseState, branch: "main" });
    expect(items.at(-1)).toMatchObject({ id: "delete", destructive: true });
  });
  it("offers archive as a non-destructive action right before delete", () => {
    const items = buildThreadActionMenuItems(baseState);
    const archiveItem = items.at(-2);
    expect(archiveItem?.id).toBe("archive");
    expect(archiveItem?.icon).toBe("archive");
    expect(archiveItem?.separatorBefore).toBe(true);
    expect(archiveItem?.destructive).toBeFalsy();
    expect(items.at(-1)?.id).toBe("delete");
  });

  it("keeps archive available even when the environment lacks every other capability", () => {
    expect(
      ids({
        ...baseState,
        supports: { settlement: false, snooze: false, pinning: false, titleRegeneration: false },
      }),
    ).toContain("archive");
  });

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("offers reload only for an idle live agent session", () => {
    const reload = buildThreadActionMenuItems(baseState).find((item) => item.id === "reload-agent");
    expect(reload).toMatchObject({ label: "Reload agent", icon: "refresh-cw", disabled: false });

    expect(
      buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
        (item) => item.id === "reload-agent",
      )?.disabled,
    ).toBe(true);
    expect(ids({ ...baseState, hasReloadableSession: false })).not.toContain("reload-agent");
  });
});
