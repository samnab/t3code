import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  ChildRunCapabilities,
  ChildRunError,
  ChildRunResult,
  ChildRunSendInput,
  ChildRunService,
  ChildRunSpawnInput,
} from "../ChildRunService.ts";
import { McpInvocationContext } from "../McpInvocationContext.ts";

const dependencies = [McpInvocationContext, ChildRunService];
const target = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
});

export const DelegationToolkit = Toolkit.make(
  Tool.make("subagent_capabilities", {
    description:
      "List configured native child providers, their exact model identifiers, and each model's supported options. Codex, Claude and Pi children use their own provider adapters. Each target truthfully reports whether it can enforce the parent's runtime mode. Results and native resume identities survive server restarts, and terminal results are delivered automatically when the parent is idle.",
    // `Schema.Struct({})` encodes to `{"anyOf":[{"type":"object"},{"type":"array"}]}`,
    // not `{"type":"object"}`. Claude's MCP client rejects a tool whose
    // top-level inputSchema isn't a plain object schema and silently drops
    // the *entire* server's tool list (all delegation and preview tools),
    // not just this one. `Schema.Record(String, Never)` encodes to the
    // correct `{"type":"object","additionalProperties":false}` for the same
    // "accepts no properties" contract.
    parameters: Schema.Record(Schema.String, Schema.Never),
    success: ChildRunCapabilities,
    failure: ChildRunError,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("subagent_spawn", {
    description:
      "Start one child turn using a configured provider instance and native model identifier. Pass optional options as `{id, value}` entries from subagent_capabilities; unknown or unsupported options fail before launch. The child inherits the parent's working directory and runtime mode and receives only sibling-messaging T3 tools. The result includes its stable agentId for teammate addressing. Options stay fixed across steering, restart recovery, and terminal follow-ups. Returns immediately: continue useful independent work in the parent and rely on T3's automatic completion report when the parent is idle; do not poll for routine progress or reconstruct unfinished child work from files. Interactive requests fail explicitly. Codex, Claude and Pi each run through their own native adapter.",
    parameters: ChildRunSpawnInput,
    success: ChildRunResult,
    failure: ChildRunError,
    dependencies,
  }),
  Tool.make("subagent_send", {
    description:
      "Send another instruction to a child. An active child is steered through its native adapter with the run's fixed model options. A terminal child starts a follow-up from its durable native resume identity with those same options and returns a new run id linked to the prior run.",
    parameters: ChildRunSendInput,
    success: ChildRunResult,
    failure: ChildRunError,
    dependencies,
  }),
  Tool.make("subagent_result", {
    description:
      "Read a child run's durable status, bounded assistant output, and requestedOptions when you need a targeted lookup for the actual task or user request. T3 automatically reports completed results when the parent is idle, so do not repeatedly poll this tool for routine progress or use it to reconstruct unfinished work. Set waitMs up to 30000 only when an explicit lookup needs to wait for completion. Set acknowledge to true to suppress a still-pending automatic notification for a terminal result; it has no effect while the run is active and fails if a durable notification attempt may already be in flight. It cannot retract an already dispatched notification. The default is false, so ordinary reads remain repeatable without changing delivery.",
    parameters: Schema.Struct({
      ...target.fields,
      waitMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
      acknowledge: Schema.optional(Schema.Boolean),
    }),
    success: ChildRunResult,
    failure: ChildRunError,
    dependencies,
  }),
  Tool.make("subagent_cancel", {
    description:
      "Request cancellation of a child run owned by this parent session. Collect with subagent_result to confirm the child session has stopped. Repeated cancellation is safe.",
    parameters: target,
    success: ChildRunResult,
    failure: ChildRunError,
    dependencies,
  }),
);

export const DelegationHandlersLive = DelegationToolkit.toLayer({
  subagent_capabilities: () =>
    Effect.gen(function* () {
      return yield* (yield* ChildRunService).capabilities(yield* McpInvocationContext);
    }),
  subagent_spawn: (input) =>
    Effect.gen(function* () {
      return yield* (yield* ChildRunService).spawn(yield* McpInvocationContext, input);
    }),
  subagent_send: (input) =>
    Effect.gen(function* () {
      return yield* (yield* ChildRunService).send(yield* McpInvocationContext, input);
    }),
  subagent_result: (input) =>
    Effect.gen(function* () {
      return yield* (yield* ChildRunService).result(
        yield* McpInvocationContext,
        input.runId,
        input.waitMs,
        input.acknowledge,
      );
    }),
  subagent_cancel: (input) =>
    Effect.gen(function* () {
      return yield* (yield* ChildRunService).cancel(yield* McpInvocationContext, input.runId);
    }),
});
