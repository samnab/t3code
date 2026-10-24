import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  makeCapabilityCheck,
  UNSUPPORTED_REALTIME_VOICE,
} from "./CodexRealtimeVoiceCapabilities.ts";

// An offline executable fixture exercises the same schema subprocess as a configured runtime.
const fixture = (mode: "supported" | "unsupported" | "malformed") => `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[process.argv.indexOf('--out') + 1];
fs.appendFileSync(path.join(__dirname, 'invocations'), 'probe\\n');
if (process.argv.slice(2, 6).join(' ') !== 'app-server generate-json-schema --experimental --out') process.exit(7);
fs.mkdirSync(path.join(out, 'v2'), {recursive:true});
fs.writeFileSync(path.join(out, 'v2/ThreadRealtimeStartParams.json'), ${mode === "malformed" ? "'{'" : mode === "unsupported" ? "'{}'" : '\'{"properties":{"clientManagedHandoffs":{"type":"boolean"}}}\''});
fs.writeFileSync(path.join(out, 'v2/ThreadRealtimeAppendSpeechParams.json'), '{"properties":{"text":{"type":"string"},"threadId":{"type":"string"}}}');
fs.writeFileSync(path.join(out, 'ClientRequest.json'), '{"oneOf":[{"properties":{"method":{"enum":["thread/realtime/start"]}}},{"properties":{"method":{"enum":["thread/realtime/appendSpeech"]}}}]}');
`;

it.live.each(["supported", "unsupported", "malformed"] as const)(
  "probes the exact configured executable with %s experimental APIs",
  (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-capability-test-" });
      const configured = path.join(directory, "configured-codex");
      const decoy = path.join(directory, "codex");
      yield* fs.writeFileString(configured, fixture(mode), { mode: 0o700 });
      yield* fs.writeFileString(
        decoy,
        fixture(mode === "supported" ? "unsupported" : "supported"),
        { mode: 0o700 },
      );
      const check = yield* makeCapabilityCheck({
        executable: configured,
        environment: { PATH: directory },
      });
      const result = yield* check.pipe(Effect.result);
      assert.equal(result._tag, mode === "supported" ? "Success" : "Failure");
      if (result._tag === "Failure")
        assert.equal(result.failure.message, UNSUPPORTED_REALTIME_VOICE);
      yield* check.pipe(Effect.result);
      assert.equal(yield* fs.readFileString(path.join(directory, "invocations")), "probe\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("rejects a replaced executable even after a successful cached probe", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-voice-capability-test-" });
    const executable = path.join(directory, "codex");
    yield* fs.writeFileString(executable, fixture("supported"), { mode: 0o700 });
    const check = yield* makeCapabilityCheck({ executable, environment: {} });
    yield* check;
    const replacement = path.join(directory, "replacement");
    yield* fs.writeFileString(replacement, fixture("unsupported"), { mode: 0o700 });
    yield* fs.rename(replacement, executable);
    assert.equal((yield* check.pipe(Effect.result))._tag, "Failure");
    const newRuntimeCheck = yield* makeCapabilityCheck({ executable, environment: {} });
    assert.equal((yield* newRuntimeCheck.pipe(Effect.result))._tag, "Failure");
    assert.equal(yield* fs.readFileString(path.join(directory, "invocations")), "probe\nprobe\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
