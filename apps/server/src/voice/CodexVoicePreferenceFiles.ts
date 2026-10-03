import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";

/** Everything the hook reads lives directly under this directory, one file per native thread. */
export const voiceDirectory = (stateDir: string, join: Path.Path["join"]) =>
  join(stateDir, "voice");

/**
 * Native thread ids come from a provider, so only a plain basename reaches the
 * filesystem. A leading alphanumeric also rules out `.`, `..` and dotfiles.
 */
const safeNativeThreadId = (nativeThreadId: string): string | null =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nativeThreadId) ? nativeThreadId : null;

/**
 * Per-thread voice preferences for Codex, which runs one shared app-server per
 * provider instance: its process environment can only carry the first thread's
 * `T3_VOICE_NOTIFICATIONS`, so the preference travels through one file per
 * Codex native thread id instead. The notify hook looks up the `thread-id` in
 * the payload it is handed and reads "0" or "1".
 *
 * `start()` subscribes to committed domain events; `apply()` folds one event
 * into the directory and is the seam tests drive.
 */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = voiceDirectory(config.stateDir, path.join);

  const filePath = (nativeThreadId: string) => {
    const safe = safeNativeThreadId(nativeThreadId);
    return safe === null ? null : path.join(directory, safe);
  };

  const write = (nativeThreadId: string, enabled: boolean): Effect.Effect<void> => {
    const target = filePath(nativeThreadId);
    if (target === null) return Effect.void;
    return writeFileStringAtomically({ filePath: target, contents: enabled ? "1" : "0" }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("voice.preference-file.write-failed", { nativeThreadId, cause }),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  };

  const remove = (nativeThreadId: string): Effect.Effect<void> => {
    const target = filePath(nativeThreadId);
    if (target === null) return Effect.void;
    return fs.remove(target).pipe(Effect.ignore);
  };

  /** The Codex native thread ids this app thread currently owns. */
  const codexNativeThreadIds = (
    threadId: ThreadId,
  ): Effect.Effect<ReadonlyArray<string>, never, never> =>
    projections.getThreadRecords(threadId, ["providerThreads"]).pipe(
      Effect.map((records) =>
        records.providerThreads.flatMap((providerThread) => {
          const nativeId = providerThread.nativeThreadRef?.nativeId;
          return providerThread.driver === "codex" && nativeId != null ? [nativeId] : [];
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("voice.preference-file.lookup-failed", { threadId, cause }).pipe(
          Effect.as<ReadonlyArray<string>>([]),
        ),
      ),
    );

  const refreshThread = (threadId: ThreadId, enabled: boolean) =>
    codexNativeThreadIds(threadId).pipe(
      Effect.flatMap((nativeThreadIds) =>
        Effect.forEach(nativeThreadIds, (nativeThreadId) => write(nativeThreadId, enabled), {
          discard: true,
        }),
      ),
    );

  const apply = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "thread.created":
        return refreshThread(event.payload.id, event.payload.voiceNotifications ?? true);
      case "thread.voice-notifications-set":
        return refreshThread(event.payload.threadId, event.payload.voiceNotifications);
      case "thread.deleted":
        return codexNativeThreadIds(event.payload.id).pipe(
          Effect.flatMap((nativeThreadIds) =>
            Effect.forEach(nativeThreadIds, remove, { discard: true }),
          ),
        );
      case "provider-thread.updated": {
        const nativeThreadId = event.payload.nativeThreadRef?.nativeId;
        const appThreadId = event.payload.appThreadId;
        if (event.payload.driver !== "codex" || nativeThreadId == null || appThreadId === null) {
          return Effect.void;
        }
        return projections.getThread(appThreadId).pipe(
          Effect.flatMap((thread) => write(nativeThreadId, thread.voiceNotifications ?? true)),
          Effect.catchCause((cause) =>
            Effect.logWarning("voice.preference-file.lookup-failed", {
              threadId: appThreadId,
              cause,
            }),
          ),
        );
      }
      default:
        return Effect.void;
    }
  };

  const start = Effect.fn("CodexVoicePreferenceFiles.start")(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* Effect.logInfo("voice.preference-files.directory", { directory });
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, apply));
  });

  return { directory, apply, start };
});
