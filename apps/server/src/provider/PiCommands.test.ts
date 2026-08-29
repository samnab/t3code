import { describe, expect, it } from "@effect/vitest";

import { expandPiSkillReference, parsePiDiscoveredCommands } from "./PiCommands.ts";

describe("parsePiDiscoveredCommands", () => {
  it("maps slash commands and skills from a get_commands payload", () => {
    const parsed = parsePiDiscoveredCommands({
      commands: [
        { name: "review", description: "Review code", source: "extension" },
        {
          name: "skill:research",
          source: "skill",
          sourceInfo: { path: "/skills/research", scope: "personal" },
          displayName: "Research",
        },
      ],
    });
    expect(parsed.slashCommands).toEqual([{ name: "review", description: "Review code" }]);
    expect(parsed.extensionCommandNames).toEqual(["review"]);
    expect(parsed.skills).toEqual([
      {
        name: "research",
        path: "/skills/research",
        enabled: true,
        scope: "user",
        displayName: "Research",
      },
    ]);
  });

  it("tolerates malformed payloads", () => {
    expect(parsePiDiscoveredCommands(undefined)).toEqual({
      slashCommands: [],
      skills: [],
      extensionCommandNames: [],
    });
    expect(parsePiDiscoveredCommands({ commands: "nope" })).toEqual({
      slashCommands: [],
      skills: [],
      extensionCommandNames: [],
    });
  });
});

describe("expandPiSkillReference", () => {
  it("hoists known $skill tokens to the leading /skill: command position", () => {
    const expanded = expandPiSkillReference("please $research the API", new Set(["research"]));
    expect(expanded).toBe("/skill:research please the API");
  });

  it("leaves text with unknown or absent skill references untouched", () => {
    expect(expandPiSkillReference("$nope stays", new Set(["research"]))).toBe("$nope stays");
    expect(expandPiSkillReference("no refs at all", new Set(["research"]))).toBe("no refs at all");
  });
});
