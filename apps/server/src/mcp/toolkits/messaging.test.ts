import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { AgentMessagingToolkit } from "./messaging.ts";

it("exposes only child messaging tools with object input schemas", () => {
  expect(Object.keys(AgentMessagingToolkit.tools).sort()).toEqual(["agent_inbox", "agent_send"]);
  for (const tool of Object.values(AgentMessagingToolkit.tools)) {
    expect(Tool.getJsonSchemaFromSchema(tool.parametersSchema).type).toBe("object");
  }
});
