import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { AgentMessagingToolkit } from "./tools.ts";

it("publishes messaging tools with plain object input schemas", () => {
  expect(Object.keys(AgentMessagingToolkit.tools).sort()).toEqual(["agent_inbox", "agent_send"]);
  for (const tool of Object.values(AgentMessagingToolkit.tools)) {
    expect(Tool.getJsonSchema(tool)).toMatchObject({ type: "object" });
  }
});
