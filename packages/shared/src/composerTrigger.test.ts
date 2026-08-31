import { describe, expect, it } from "vite-plus/test";

import {
  parseThreadGoalCommand,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("parseThreadGoalCommand", () => {
  it("shows on bare /goal with surrounding whitespace", () => {
    expect(parseThreadGoalCommand("  /goal  ")).toEqual({ action: "show" });
  });

  it("sets a trimmed goal with preserved unicode", () => {
    expect(parseThreadGoalCommand("/goal  Ship the ✨ login fix ")).toEqual({
      action: "set",
      goal: "Ship the ✨ login fix",
    });
  });

  it("clears on reserved clear, case-insensitive", () => {
    expect(parseThreadGoalCommand("/goal clear")).toEqual({ action: "clear" });
    expect(parseThreadGoalCommand("/GOAL CLEAR")).toEqual({ action: "clear" });
  });

  it("matches command case-insensitively like other built-ins", () => {
    expect(parseThreadGoalCommand("/Goal ship it")).toEqual({
      action: "set",
      goal: "ship it",
    });
  });

  it("does not intercept ordinary prompts containing /goal", () => {
    expect(parseThreadGoalCommand("please run /goal now")).toBeNull();
    expect(parseThreadGoalCommand("/goaling the deploy")).toBeNull();
    expect(parseThreadGoalCommand("")).toBeNull();
  });

  it("keeps multi-line remainders as the goal", () => {
    expect(parseThreadGoalCommand("/goal fix\nall the bugs")).toEqual({
      action: "set",
      goal: "fix\nall the bugs",
    });
  });

  it("accepts line breaks and NBSP as command separators", () => {
    expect(parseThreadGoalCommand("/goal\nship the fix")).toEqual({
      action: "set",
      goal: "ship the fix",
    });
    expect(parseThreadGoalCommand("/goal\r\nship the fix")).toEqual({
      action: "set",
      goal: "ship the fix",
    });
    expect(parseThreadGoalCommand("/goal\u00a0ship the fix")).toEqual({
      action: "set",
      goal: "ship the fix",
    });
  });

  it("shows when only whitespace follows the command", () => {
    expect(parseThreadGoalCommand("/goal \n\t \u00a0")).toEqual({ action: "show" });
  });

  it("trims multi-line goals and clears via a line-break separator", () => {
    expect(parseThreadGoalCommand("/goal \n ship it\nnow \n")).toEqual({
      action: "set",
      goal: "ship it\nnow",
    });
    expect(parseThreadGoalCommand("/goal\nclear")).toEqual({ action: "clear" });
  });

  it("does not treat zero-width characters as separators", () => {
    expect(parseThreadGoalCommand("/goal\u200bship it")).toBeNull();
    expect(parseThreadGoalCommand("/goal\u200b")).toBeNull();
  });
});
