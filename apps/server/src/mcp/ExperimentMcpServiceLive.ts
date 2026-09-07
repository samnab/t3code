import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ExperimentService } from "../experiments/ExperimentService.ts";
import type { ExperimentError } from "../experiments/Model.ts";
import { ExperimentMcpError } from "./ExperimentMcpModel.ts";
import { ExperimentMcpService } from "./ExperimentMcpService.ts";

function toMcpError(cause: ExperimentError): ExperimentMcpError {
  const code: ExperimentMcpError["code"] = (() => {
    switch (cause.code) {
      case "authentication_failed":
        return "PROVIDER_EXPERIMENT_UNAUTHORIZED";
      case "unsupported_provider":
        return "PROVIDER_EXPERIMENT_UNSUPPORTED";
      case "invalid_config":
        return "EXPERIMENT_INVALID_REQUEST";
      case "unsafe_repository":
        return "EXPERIMENT_INVALID_PATH";
      case "thread_busy":
      case "confirmation_invalid":
      case "invalid_phase":
      case "limits_exhausted":
      case "evaluation_failed":
      case "external_drift":
      case "persistence_failed":
        return "EXPERIMENT_UNAVAILABLE";
    }
  })();
  return new ExperimentMcpError({ code, message: cause.message.slice(0, 2_000) });
}

/** Adapts authenticated experiment MCP calls to the authoritative service. */
export const layer = Layer.effect(
  ExperimentMcpService,
  Effect.gen(function* () {
    const experiments = yield* ExperimentService;
    return ExperimentMcpService.of({
      status: (identity) => experiments.status(identity).pipe(Effect.mapError(toMcpError)),
      listFiles: (identity) => experiments.listFiles(identity).pipe(Effect.mapError(toMcpError)),
      readFile: (input) => experiments.readFile(input).pipe(Effect.mapError(toMcpError)),
      apply: (input) => experiments.apply(input).pipe(Effect.mapError(toMcpError)),
      evaluate: (identity) => experiments.evaluate(identity).pipe(Effect.mapError(toMcpError)),
    });
  }),
);
