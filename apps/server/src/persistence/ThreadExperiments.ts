import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  decodeExperimentProfile,
  ExperimentError,
  type ExperimentProfile,
} from "../experiments/Model.ts";

const Row = Schema.Struct({
  threadId: Schema.String,
  goalGeneration: Schema.Int,
  profileJson: Schema.String,
  updatedAt: Schema.String,
});
type Row = typeof Row.Type;

const ThreadInput = Schema.Struct({ threadId: Schema.String });
const SaveInput = Schema.Struct({
  threadId: Schema.String,
  goalGeneration: Schema.Int,
  profileJson: Schema.String,
  updatedAt: Schema.String,
});

function persistenceError(operation: string, cause: unknown): ExperimentError {
  return new ExperimentError({
    code: "persistence_failed",
    message: `Experiment persistence failed during ${operation}.`,
    cause,
  });
}

function decodeRow(row: Row): ExperimentProfile {
  try {
    const profile = decodeExperimentProfile(JSON.parse(row.profileJson));
    if (
      profile.threadId !== row.threadId ||
      profile.goalGeneration !== row.goalGeneration ||
      profile.updatedAt !== row.updatedAt
    ) {
      throw new Error("Experiment profile identity does not match its row.");
    }
    return profile;
  } catch (cause) {
    throw persistenceError("decode", cause);
  }
}

export interface ThreadExperimentStoreShape {
  readonly get: (
    threadId: string,
  ) => Effect.Effect<Option.Option<ExperimentProfile>, ExperimentError>;
  readonly save: (profile: ExperimentProfile) => Effect.Effect<void, ExperimentError>;
  readonly list: () => Effect.Effect<ReadonlyArray<ExperimentProfile>, ExperimentError>;
}

export class ThreadExperimentStore extends Context.Service<
  ThreadExperimentStore,
  ThreadExperimentStoreShape
>()("t3/persistence/ThreadExperiments/ThreadExperimentStore") {}

export const makeThreadExperimentStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const getRow = SqlSchema.findOneOption({
    Request: ThreadInput,
    Result: Row,
    execute: ({ threadId }) => sql`
      SELECT thread_id AS "threadId", goal_generation AS "goalGeneration",
        profile_json AS "profileJson", updated_at AS "updatedAt"
      FROM thread_experiments WHERE thread_id = ${threadId}
    `,
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Row,
    execute: () => sql`
      SELECT thread_id AS "threadId", goal_generation AS "goalGeneration",
        profile_json AS "profileJson", updated_at AS "updatedAt"
      FROM thread_experiments ORDER BY updated_at ASC, thread_id ASC
    `,
  });
  const saveRow = SqlSchema.void({
    Request: SaveInput,
    execute: (input) => sql`
      INSERT INTO thread_experiments (thread_id, goal_generation, profile_json, updated_at)
      VALUES (${input.threadId}, ${input.goalGeneration}, ${input.profileJson}, ${input.updatedAt})
      ON CONFLICT (thread_id) DO UPDATE SET
        goal_generation = excluded.goal_generation,
        profile_json = excluded.profile_json,
        updated_at = excluded.updated_at
    `,
  });

  return ThreadExperimentStore.of({
    get: (threadId) =>
      getRow({ threadId }).pipe(
        Effect.map(Option.map(decodeRow)),
        Effect.mapError((cause) => persistenceError("get", cause)),
      ),
    save: (profile) =>
      saveRow({
        threadId: profile.threadId,
        goalGeneration: profile.goalGeneration,
        profileJson: JSON.stringify(profile),
        updatedAt: profile.updatedAt,
      }).pipe(Effect.mapError((cause) => persistenceError("save", cause))),
    list: () =>
      listRows(undefined).pipe(
        Effect.map((rows) => rows.map(decodeRow)),
        Effect.mapError((cause) => persistenceError("list", cause)),
      ),
  });
});

export const layer = Layer.effect(ThreadExperimentStore, makeThreadExperimentStore);

export const memoryLayer = Layer.sync(ThreadExperimentStore, () => {
  const rows = new Map<string, ExperimentProfile>();
  return ThreadExperimentStore.of({
    get: (threadId) => Effect.sync(() => Option.fromUndefinedOr(rows.get(threadId))),
    save: (profile) => Effect.sync(() => void rows.set(profile.threadId, structuredClone(profile))),
    list: () => Effect.sync(() => [...rows.values()].map((profile) => structuredClone(profile))),
  });
});
