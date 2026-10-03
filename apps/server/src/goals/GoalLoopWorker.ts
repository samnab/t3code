import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as GoalLoop from "./GoalLoopService.ts";

export const workerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const goals = yield* GoalLoop.GoalLoopService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("thread-goal-loop", goals.runDueWork);
  }),
);
