import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { DelegationToolkit } from "./delegation.ts";

// Regression: `parameters: Schema.Struct({})` (used for subagent_capabilities,
// which takes no arguments) encodes to `{"anyOf":[{"type":"object"},{"type":
// "array"}]}` instead of `{"type":"object"}`. Claude's MCP client rejects a
// tool whose top-level inputSchema isn't a plain object schema, and drops the
// *entire* server's tool list as a result — verified against the real
// claude-agent-sdk/CLI, which reported zero mcp__t3-code__* tools with the
// old schema and all of them once every tool's inputSchema is a bare object.
it("every delegation tool has an object-typed inputSchema", () => {
  for (const tool of Object.values(DelegationToolkit.tools)) {
    const jsonSchema = Tool.getJsonSchemaFromSchema(tool.parametersSchema);
    expect(jsonSchema.type, `${tool.name} inputSchema`).toBe("object");
  }
});

it("keeps acknowledgement optional on subagent_result", () => {
  const schema = Tool.getJsonSchemaFromSchema(
    DelegationToolkit.tools.subagent_result.parametersSchema,
  );
  expect(schema).toMatchObject({
    properties: {
      acknowledge: {
        anyOf: expect.arrayContaining([expect.objectContaining({ type: "boolean" })]),
      },
    },
  });
  expect(schema.required).not.toContain("acknowledge");
});
