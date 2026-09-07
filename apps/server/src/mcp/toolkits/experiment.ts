import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ExperimentModel from "../ExperimentMcpModel.ts";
import { ExperimentMcpService } from "../ExperimentMcpService.ts";
import { McpInvocationContext, requireExperimentMcpInvocation } from "../McpInvocationContext.ts";

const NoInput = Schema.Record(Schema.String, Schema.Never);
const dependencies = [McpInvocationContext, ExperimentMcpService];

export const ExperimentToolkit = Toolkit.make(
  Tool.make("experiment_status", {
    description: "Read the current bounded summary for this experiment run.",
    parameters: NoInput,
    success: ExperimentModel.ExperimentSummary,
    failure: ExperimentModel.ExperimentMcpError,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("experiment_list_files", {
    description: "List the paths approved for this experiment run.",
    parameters: NoInput,
    success: ExperimentModel.ExperimentFileList,
    failure: ExperimentModel.ExperimentMcpError,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("experiment_read_file", {
    description: "Read bounded content from one approved regular file.",
    parameters: ExperimentModel.ExperimentReadFileInput,
    success: ExperimentModel.ExperimentReadFileResult,
    failure: ExperimentModel.ExperimentMcpError,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("experiment_apply", {
    description: "Apply complete replacement contents to approved files for one stated hypothesis.",
    parameters: ExperimentModel.ExperimentApplyInput,
    success: ExperimentModel.ExperimentApplyResult,
    failure: ExperimentModel.ExperimentMcpError,
    dependencies,
  }).annotate(Tool.Destructive, true),
  Tool.make("experiment_evaluate", {
    description: "Run the fixed server-owned evaluator and checks for the current candidate.",
    parameters: NoInput,
    success: ExperimentModel.ExperimentEvaluateResult,
    failure: ExperimentModel.ExperimentMcpError,
    dependencies,
  }),
);

export const ExperimentHandlersLive = ExperimentToolkit.toLayer({
  experiment_status: () =>
    Effect.gen(function* () {
      const identity = yield* requireExperimentMcpInvocation();
      return yield* (yield* ExperimentMcpService).status(identity);
    }),
  experiment_list_files: () =>
    Effect.gen(function* () {
      const identity = yield* requireExperimentMcpInvocation();
      return yield* (yield* ExperimentMcpService).listFiles(identity);
    }),
  experiment_read_file: (input) =>
    Effect.gen(function* () {
      const identity = yield* requireExperimentMcpInvocation();
      return yield* (yield* ExperimentMcpService).readFile({ ...identity, ...input });
    }),
  experiment_apply: (input) =>
    Effect.gen(function* () {
      const identity = yield* requireExperimentMcpInvocation();
      return yield* (yield* ExperimentMcpService).apply({ ...identity, ...input });
    }),
  experiment_evaluate: () =>
    Effect.gen(function* () {
      const identity = yield* requireExperimentMcpInvocation();
      return yield* (yield* ExperimentMcpService).evaluate(identity);
    }),
});
