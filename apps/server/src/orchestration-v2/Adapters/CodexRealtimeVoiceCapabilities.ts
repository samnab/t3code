import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

export const UNSUPPORTED_REALTIME_VOICE =
  "This configured Codex executable cannot verify client-managed realtime handoffs and appendSpeech. Update or select a supported Codex runtime before starting voice.";

export class CapabilityError extends Schema.TaggedError<CapabilityError>()(
  "CodexRealtimeVoiceCapabilityError",
  { message: Schema.String },
) {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function propertyType(value: unknown, name: string, type: string): boolean {
  return (
    isRecord(value) &&
    isRecord(value.properties) &&
    isRecord(value.properties[name]) &&
    (value.properties[name].type === type ||
      (Array.isArray(value.properties[name].type) &&
        value.properties[name].type.includes(type) &&
        value.properties[name].type.every((entry: unknown) => entry === type || entry === "null")))
  );
}

/** Validate generated experimental APIs, rather than inferring support from a version. */
export function supportsManagedRealtimeVoice(start: unknown, speech: unknown, requests: unknown) {
  if (!isRecord(requests) || !Array.isArray(requests.oneOf)) return false;
  const methods = requests.oneOf;
  return (
    propertyType(start, "clientManagedHandoffs", "boolean") &&
    propertyType(speech, "threadId", "string") &&
    propertyType(speech, "text", "string") &&
    ["thread/realtime/start", "thread/realtime/appendSpeech"].every((method) =>
      methods.some(
        (entry: unknown) =>
          isRecord(entry) &&
          isRecord(entry.properties) &&
          isRecord(entry.properties.method) &&
          Array.isArray(entry.properties.method.enum) &&
          entry.properties.method.enum.includes(method),
      ),
    )
  );
}

const executableIdentity = Effect.fn("CodexRealtimeVoiceCapabilities.executableIdentity")(
  function* (executable: string) {
    const fs = yield* FileSystem.FileSystem;
    const realPath = yield* fs.realPath(executable);
    const stat = yield* fs.stat(realPath);
    return `${realPath}:${stat.dev}:${Option.getOrNull(stat.ino)}:${stat.size}:${Option.getOrNull(Option.map(stat.mtime, (date) => date.getTime()))}`;
  },
);

/** Pin the resolved launcher's file identity; wrappers may delegate to a different native binary. */
export const makeCapabilityCheck = Effect.fn("CodexRealtimeVoiceCapabilities.makeCapabilityCheck")(
  function* (input: { readonly executable: string; readonly environment: NodeJS.ProcessEnv }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const identity = yield* executableIdentity(input.executable);
    const probe = yield* Effect.cached(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-voice-schema-" });
          const resolved = yield* resolveSpawnCommand(
            input.executable,
            ["app-server", "generate-json-schema", "--experimental", "--out", directory],
            { env: input.environment },
          );
          const child = yield* spawner.spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              env: input.environment,
              extendEnv: false,
              shell: resolved.shell,
            }),
          );
          const [code] = yield* Effect.all(
            [
              child.exitCode,
              child.stdout.pipe(Stream.runDrain),
              child.stderr.pipe(Stream.runDrain),
            ],
            { concurrency: "unbounded" },
          );
          if (Number(code) !== 0)
            return yield* Effect.fail(new CapabilityError({ message: UNSUPPORTED_REALTIME_VOICE }));
          const read = (file: string) =>
            fs
              .readFileString(path.join(directory, file))
              .pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
              );
          const [start, speech, requests] = yield* Effect.all([
            read("v2/ThreadRealtimeStartParams.json"),
            read("v2/ThreadRealtimeAppendSpeechParams.json"),
            read("ClientRequest.json"),
          ]);
          if (!supportsManagedRealtimeVoice(start, speech, requests))
            return yield* Effect.fail(new CapabilityError({ message: UNSUPPORTED_REALTIME_VOICE }));
        }),
      ).pipe(Effect.timeout("15 seconds")),
    );
    return Effect.gen(function* () {
      if ((yield* executableIdentity(input.executable)) !== identity)
        return yield* Effect.fail(new CapabilityError({ message: UNSUPPORTED_REALTIME_VOICE }));
      yield* probe;
      if ((yield* executableIdentity(input.executable)) !== identity)
        return yield* Effect.fail(new CapabilityError({ message: UNSUPPORTED_REALTIME_VOICE }));
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.mapError(() => new CapabilityError({ message: UNSUPPORTED_REALTIME_VOICE })),
    );
  },
);
