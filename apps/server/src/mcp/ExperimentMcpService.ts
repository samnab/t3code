import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ExperimentApplyInput,
  ExperimentApplyResult,
  ExperimentEvaluateResult,
  ExperimentFileList,
  ExperimentMcpError,
  ExperimentMcpIdentity,
  ExperimentReadFileInput,
  ExperimentReadFileResult,
  ExperimentSummary,
} from "./ExperimentMcpModel.ts";

export interface ExperimentMcpServiceShape {
  readonly status: (
    identity: ExperimentMcpIdentity,
  ) => Effect.Effect<ExperimentSummary, ExperimentMcpError>;
  readonly listFiles: (
    identity: ExperimentMcpIdentity,
  ) => Effect.Effect<ExperimentFileList, ExperimentMcpError>;
  readonly readFile: (
    input: ExperimentMcpIdentity & ExperimentReadFileInput,
  ) => Effect.Effect<ExperimentReadFileResult, ExperimentMcpError>;
  readonly apply: (
    input: ExperimentMcpIdentity & ExperimentApplyInput,
  ) => Effect.Effect<ExperimentApplyResult, ExperimentMcpError>;
  readonly evaluate: (
    identity: ExperimentMcpIdentity,
  ) => Effect.Effect<ExperimentEvaluateResult, ExperimentMcpError>;
}

/** Narrow port implemented by the authoritative ExperimentService at server composition. */
export class ExperimentMcpService extends Context.Service<
  ExperimentMcpService,
  ExperimentMcpServiceShape
>()("t3/mcp/ExperimentMcpService") {}
