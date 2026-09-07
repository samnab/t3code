import {
  WS_METHODS,
  type ThreadExperimentGetInput,
  type ThreadExperimentPreviewInput,
  type ThreadExperimentStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

export const previewThreadExperiment = Effect.fn(
  "EnvironmentCommands.previewThreadExperiment",
)(function* (input: ThreadExperimentPreviewInput) {
  return yield* request(WS_METHODS.threadExperimentPreview, input);
});

export const startThreadExperiment = Effect.fn(
  "EnvironmentCommands.startThreadExperiment",
)(function* (input: ThreadExperimentStartInput) {
  return yield* request(WS_METHODS.threadExperimentStart, input);
});

export const getThreadExperiment = Effect.fn("EnvironmentCommands.getThreadExperiment")(
  function* (input: ThreadExperimentGetInput) {
    return yield* request(WS_METHODS.threadExperimentGet, input);
  },
);
