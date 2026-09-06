import { Effect, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  ChildRunCapabilities,
  ChildRunError,
  ChildRunResult,
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
      "List configured native child providers and delegation limits. Codex, Claude and Pi children use their own provider adapters. Restricted parents are currently unsupported. Results last for this server lifetime, with at most 256 retained runs. Completion requires subagent_result; no automatic parent wake-up.",
    parameters: Schema.Struct({}),
    success: ChildRunCapabilities,
    failure: ChildRunError,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("subagent_spawn", {
    description:
      "Start one child turn using a configured provider instance and its native model identifier. The child inherits the parent's working directory and full-access runtime mode, receives only your prompt, and has no T3 delegation tools. Returns immediately; collect with subagent_result. Interactive requests fail explicitly. No Pi dependency for Codex or Claude children.",
    parameters: ChildRunSpawnInput,
    success: ChildRunResult,
    failure: ChildRunError,
    dependencies,
  }),
  Tool.make("subagent_result", {
    description:
      "Read a child run's status and bounded assistant output. Set waitMs up to 30000 to wait for completion. A starting/running response requires another call; terminal results are repeatable until eviction or server restart. Only the parent session can access this run.",
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
