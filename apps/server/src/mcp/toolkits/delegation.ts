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
      "List configured native child providers and delegation limits. Codex, Claude and Pi children use their own provider adapters. Each target truthfully reports whether it can enforce the parent's runtime mode. Results and native resume identities survive server restarts, and terminal results are delivered automatically when the parent is idle.",
    parameters: Schema.Struct({}),
    success: ChildRunCapabilities,
    failure: ChildRunError,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("subagent_spawn", {
    description:
      "Start one child turn using a configured provider instance and native model identifier. The child inherits the parent's working directory and runtime mode, receives only your prompt, and has no T3 delegation tools. Returns immediately. Interactive requests fail explicitly. Codex, Claude and Pi each run through their own native adapter.",
    parameters: ChildRunSpawnInput,
    success: ChildRunResult,
    failure: ChildRunError,
    dependencies,
  }),
  Tool.make("subagent_send", {
    description:
      "Send another instruction to a child. An active child is steered through its native adapter. A terminal child starts a follow-up from its durable native resume identity and returns a new run id linked to the prior run.",
    parameters: ChildRunSendInput,
    success: ChildRunResult,
    failure: ChildRunError,
    dependencies,
  }),
  Tool.make("subagent_result", {
    description:
      "Read a child run's durable status and bounded assistant output. Set waitMs up to 30000 to wait for completion. Terminal results are repeatable across parent credential renewal and server restart. Reading a result does not suppress automatic delivery.",
    parameters: Schema.Struct({
      ...target.fields,
      waitMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30_000 }))),
    }),
    success: ChildRunResult,
    failure: ChildRunError,
    dependencies,
  }).annotate(Tool.Readonly, true),
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
      );
    }),
  subagent_cancel: (input) =>
    Effect.gen(function* () {
      return yield* (yield* ChildRunService).cancel(yield* McpInvocationContext, input.runId);
    }),
});
