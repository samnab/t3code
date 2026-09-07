import { assert, describe, it } from "@effect/vitest";

import { commandEnvironment, ExperimentProcessRegistry } from "./Process.ts";

describe("ExperimentProcessRegistry", () => {
  it("passes only system execution variables and no credentials", () => {
    assert.deepEqual(
      commandEnvironment({
        PATH: "/bin",
        HOME: "/home/test",
        LANG: "en_CA.UTF-8",
        AWS_SECRET_ACCESS_KEY: "secret",
        T3_SERVER_TOKEN: "secret",
        OPENAI_API_KEY: "secret",
      }),
      { PATH: "/bin", HOME: "/home/test", LANG: "en_CA.UTF-8" },
    );
  });

  it("terminates a process group at its output cap", async () => {
    const registry = new ExperimentProcessRegistry();
    const result = await registry.run(
      "run",
      ["node", "-e", "process.stdout.write('x'.repeat(100000))"],
      { cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 1_024 },
    );
    assert.strictEqual(result.termination, "output_limit");
    assert.isAtMost(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1_024);
  });

  it("terminates a process group at its timeout", async () => {
    const registry = new ExperimentProcessRegistry();
    const result = await registry.run("run", ["node", "-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      timeoutMs: 25,
      maxOutputBytes: 1_024,
    });
    assert.strictEqual(result.termination, "timeout");
  });
});
