import { describe, expect, it, vi } from "vite-plus/test";

import { reapCodexDescendantProcesses } from "./CodexAdapterV2.ts";

describe("reapCodexDescendantProcesses", () => {
  it("kills only descendants from the recorded process tree", () => {
    const kill = vi.fn();
    const killed = reapCodexDescendantProcesses(100, {
      platform: "darwin",
      processTable: () => `
        100 1
        110 100
        111 100
        120 110
        999 1
        998 999
        malformed
      `,
      kill,
    });

    expect(new Set(killed)).toEqual(new Set([110, 111, 120]));
    expect(kill.mock.calls.map(([pid]) => pid)).not.toContain(100);
    expect(kill.mock.calls.map(([pid]) => pid)).not.toContain(999);
    expect(kill.mock.calls.map(([pid]) => pid)).not.toContain(998);
    expect(kill.mock.calls.every(([, signal]) => signal === "SIGKILL")).toBe(true);
  });

  it("does nothing on Windows", () => {
    const kill = vi.fn();
    expect(
      reapCodexDescendantProcesses(100, {
        platform: "win32",
        processTable: () => "110 100",
        kill,
      }),
    ).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });
});
