import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import { ExperimentService } from "./ExperimentService.ts";

export const ACTIVATION_COMMAND_PREFIX = "server:experiment-activate:";

export class ExperimentLifecycleReactor extends Context.Service<
  ExperimentLifecycleReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/experiments/ExperimentLifecycleReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const experiments = yield* ExperimentService;

  const handle = (event: OrchestrationEvent) => {
    if (event.type === "thread.goal-loop-updated") {
      const loop = event.payload.loop;
      if (loop === null) {
        return experiments.settle({
          threadId: event.payload.threadId,
          terminal: "clear",
          reason: "Experiment goal was cleared.",
        });
      }
      if (loop.kind !== "experiment") return Effect.void;
      switch (loop.state) {
        case "paused":
          return experiments.settle({
            threadId: event.payload.threadId,
            terminal: "pause",
            reason: loop.reason ?? "Experiment paused.",
          });
        case "capped":
          return experiments.settle({
            threadId: event.payload.threadId,
            terminal: "capped",
            reason: loop.reason ?? "Goal-loop continuation cap reached.",
          });
        case "blocked":
          return experiments.settle({
            threadId: event.payload.threadId,
            terminal: "block",
            reason: loop.reason ?? "Experiment blocked.",
          });
        case "completed":
          return experiments.settle({
            threadId: event.payload.threadId,
            terminal: "complete",
            reason: "Experiment goal completed.",
          });
        case "idle":
        case "running":
          return event.payload.resumed === true
            ? experiments.resume(event.payload.threadId)
            : Effect.void;
      }
    }
    if (
      event.type === "thread.meta-updated" &&
      !event.commandId?.startsWith(ACTIVATION_COMMAND_PREFIX) &&
      (event.payload.goal !== undefined ||
        event.payload.modelSelection !== undefined ||
        event.payload.branch !== undefined ||
        event.payload.worktreePath !== undefined)
    ) {
      return experiments.settle({
        threadId: event.payload.threadId,
        terminal: "block",
        reason: "Thread goal, provider, or worktree metadata changed during the experiment.",
      });
    }
    if (event.type === "thread.deleted" || event.type === "thread.archived") {
      return experiments.settle({
        threadId: event.payload.threadId,
        terminal: "clear",
        reason: "Thread was removed while an experiment was active.",
      });
    }
    return Effect.void;
  };

  const start: ExperimentLifecycleReactor["Service"]["start"] = Effect.fn(
    "ExperimentLifecycleReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        handle(event).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError("experiment lifecycle transition failed", {
                  threadId: event.aggregateId,
                  eventType: event.type,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      ),
    );
  });

  return { start } satisfies ExperimentLifecycleReactor["Service"];
});

export const layer = Layer.effect(ExperimentLifecycleReactor, make);
