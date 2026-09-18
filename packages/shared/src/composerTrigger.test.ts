import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  hasVisibleThreadGoalText,
  parseThreadGoalCommand,
  serializeComposerFileLink,
} from "./composerTrigger.ts";

describe("detectComposerTrigger", () => {
  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );
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

  it("parses an experiment objective with Unicode separators", () => {
    expect(parseThreadGoalCommand("/goal\u3000experiment\u202fTune the résumé 🚀 ")).toEqual({
      action: "experiment",
      objective: "Tune the résumé 🚀",
    });
  });

  it("keeps a missing experiment objective explicit for validation", () => {
    expect(parseThreadGoalCommand("/goal experiment \n\t")).toEqual({
      action: "experiment",
      objective: "",
    });
  });

  it("keeps ordinary goal parsing unchanged around the reserved word", () => {
    expect(parseThreadGoalCommand("/goal experimenter")).toEqual({
      action: "set",
      goal: "experimenter",
    });
    expect(parseThreadGoalCommand("/goal experiment\u200btune it")).toEqual({
      action: "set",
      goal: "experiment\u200btune it",
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

  it("rejects goals with no visible characters", () => {
    expect(hasVisibleThreadGoalText("")).toBe(false);
    expect(hasVisibleThreadGoalText("  \n\t \u00a0")).toBe(false);
    expect(hasVisibleThreadGoalText("\u200b")).toBe(false);
    expect(hasVisibleThreadGoalText("\ufeff\u200b\u2060")).toBe(false);
    expect(hasVisibleThreadGoalText(" \u200b\n\ufeff\t")).toBe(false);
    // Legitimate content passes, including edge formatting marks and emoji.
    expect(hasVisibleThreadGoalText("ship it")).toBe(true);
    expect(hasVisibleThreadGoalText("résumé 🚀")).toBe(true);
    expect(hasVisibleThreadGoalText("e\u0301gal\u00e9")) // combining acute
      .toBe(true);
    expect(hasVisibleThreadGoalText("\u200bship\u200b")).toBe(true);
    expect(hasVisibleThreadGoalText("日本語のゴール")).toBe(true);
    expect(hasVisibleThreadGoalText("العربية")).toBe(true);
  });

  it("trims multi-line goals and clears via a line-break separator", () => {
    expect(parseThreadGoalCommand("/goal \n ship it\nnow \n")).toEqual({
      action: "set",
      goal: "ship it\nnow",
    });
    expect(parseThreadGoalCommand("/goal\nclear")).toEqual({ action: "clear" });
  });

  it("does not treat zero-width or formatting characters as separators", () => {
    // U+200B ZERO WIDTH SPACE, U+FEFF BOM/ZWNBSP, and U+2060 WORD JOINER render
    // as nothing but are formatting characters, not Unicode White_Space: the
    // joined text stays an ordinary prompt instead of a goal command.
    expect(parseThreadGoalCommand("/goal\u200bship it")).toBeNull();
    expect(parseThreadGoalCommand("/goal\u200b")).toBeNull();
    expect(parseThreadGoalCommand("/goal\ufeffship it")).toBeNull();
    expect(parseThreadGoalCommand("/goal\ufeff")).toBeNull();
    expect(parseThreadGoalCommand("/goal\u2060ship it")).toBeNull();
  });

  it("trims only accepted whitespace at outer boundaries", () => {
    // Formatting characters are content even at the edges: they neither
    // separate the command from its goal nor get trimmed away, so a goal
    // keeps them verbatim and a FEFF-joined text never becomes a command.
    expect(parseThreadGoalCommand("\ufeff/goal\ufeff")).toBeNull();
    expect(parseThreadGoalCommand("/goal ship it\ufeff")).toEqual({
      action: "set",
      goal: "ship it\ufeff",
    });
    expect(parseThreadGoalCommand("\u00a0/goal\u00a0ship\u00a0")).toEqual({
      action: "set",
      goal: "ship",
    });
  });

  it("accepts exactly the Unicode White_Space delimiters", () => {
    // Every Unicode White_Space code point separates /goal from its argument.
    for (const separator of [
      " ",
      "\t",
      "\n",
      "\r\n",
      "\r",
      "\u00a0",
      "\u1680",
      "\u2000",
      "\u2028",
      "\u2029",
      "\u202f",
      "\u205f",
      "\u3000",
    ]) {
      expect(parseThreadGoalCommand(`/goal${separator}ship it`)).toEqual({
        action: "set",
        goal: "ship it",
      });
    }
  });
});
