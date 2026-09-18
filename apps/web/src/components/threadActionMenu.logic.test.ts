import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  hasReloadableSession: true,
  supports: { settlement: true, snooze: true, pinning: true, titleRegeneration: true },
  executionGoal: false,
  goal: null,
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

  it("offers project filtering only for surfaces with a scoped thread list", () => {
    expect(ids(baseState)).not.toContain("filter-by-project");
    expect(
      buildThreadActionMenuItems({
        ...baseState,
        projectFilter: { label: "Beta Project", isActive: false },
      }).find((item) => item.id === "filter-by-project"),
    ).toMatchObject({ label: "Filter by Beta Project", icon: "folder-tree" });
  });

  it("offers the way back to all projects once the list is scoped", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      projectFilter: { label: "Beta Project", isActive: true },
    });
    const filterIndex = items.findIndex((candidate) => candidate.id === "filter-by-project");
    expect(items[filterIndex]).toMatchObject({ label: "Show all projects", icon: "folder-tree" });
    expect(items[filterIndex - 1]?.id).toBe("mark-unread");
    expect(items[filterIndex + 1]?.id).toBe("copy");
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
    expect(snooze?.children?.map((child) => child.id)).toEqual(["snooze:hour", "snooze:custom"]);
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
    expect(items).not.toContain("continue-goal-loop");
    expect(items).not.toContain("restart-goal-loop");
  });

  it("offers continue for a capped standard goal loop", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      goal: "Ship it",
      goalLoop: {
        kind: "standard",
        state: "capped",
        mode: "t3",
        iterations: 10,
        maxIterations: 10,
        reason: null,
        experiment: null,
        updatedAt: "2026-09-07T02:00:00.000Z",
      },
    });

    expect(items.find((item) => item.id === "continue-goal-loop")).toMatchObject({
      label: "Continue anyway",
    });
    expect(items.map((item) => item.id)).not.toContain("restart-goal-loop");
  });

  it("offers restart for a completed standard goal loop", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      goal: "Ship it",
      goalLoop: {
        kind: "standard",
        state: "completed",
        mode: "t3",
        iterations: 4,
        maxIterations: 10,
        reason: null,
        experiment: null,
        updatedAt: "2026-09-07T02:00:00.000Z",
      },
    });

    expect(items.find((item) => item.id === "restart-goal-loop")).toMatchObject({
      label: "Restart goal",
    });
    expect(items.map((item) => item.id)).not.toContain("continue-goal-loop");
  });

  it("offers stop only while a goal loop exists and a turn is running", () => {
    const runningLoop = {
      kind: "standard",
      state: "running",
      mode: "t3",
      iterations: 1,
      maxIterations: 10,
      reason: null,
      experiment: null,
      updatedAt: "2026-09-07T02:00:00.000Z",
    } as const;
    expect(ids({ ...baseState, goalLoop: runningLoop, isRunning: true })).toContain(
      "stop-goal-loop",
    );
    // No active turn: stop has nothing to interrupt.
    expect(ids({ ...baseState, goalLoop: runningLoop, isRunning: false })).not.toContain(
      "stop-goal-loop",
    );
    // No goal loop at all.
    expect(ids({ ...baseState, isRunning: true })).not.toContain("stop-goal-loop");
  });

  it("offers a destructive delete goal whenever a goal is saved", () => {
    const runningLoop = {
      kind: "standard",
      state: "running",
      mode: "t3",
      iterations: 1,
      maxIterations: 10,
      reason: null,
      experiment: null,
      updatedAt: "2026-09-07T02:00:00.000Z",
    } as const;
    const item = buildThreadActionMenuItems({
      ...baseState,
      goal: "Ship it",
      goalLoop: runningLoop,
    }).find((candidate) => candidate.id === "delete-goal");
    expect(item).toMatchObject({ id: "delete-goal", destructive: true });
    expect(ids({ ...baseState, goal: "Ship it" })).toContain("delete-goal");
    expect(ids(baseState)).not.toContain("delete-goal");
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
