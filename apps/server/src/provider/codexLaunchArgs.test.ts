import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexAppServerArgs, codexExecLaunchArgs } from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });

  it("appends structured concurrency overrides after conflicting launch args", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(
        "-c agents.max_concurrent_threads_per_session=2 -c features.multi_agent_v2.max_concurrent_threads_per_session=3",
        "20",
      ),
      [
        "app-server",
        "-c",
        "agents.max_concurrent_threads_per_session=2",
        "-c",
        "features.multi_agent_v2.max_concurrent_threads_per_session=3",
        "-c",
        "agents.max_concurrent_threads_per_session=20",
        "-c",
        "features.multi_agent_v2.max_concurrent_threads_per_session=21",
      ],
    );
  });

  it.each([undefined, "", "0", "-1", "1.5", "9007199254740992"])(
    "ignores an invalid or empty concurrency override: %s",
    (value) => {
      NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config", value), [
        "app-server",
        "--strict-config",
      ]);
    },
  );
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
