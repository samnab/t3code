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

  it("classifies a fast process by its combined output cap after both streams drain", async () => {
    const registry = new ExperimentProcessRegistry();
    const result = await registry.run(
      "run",
      ["node", "-e", "process.stdout.write('x'.repeat(700));process.stderr.write('y'.repeat(700))"],
      { cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 1_024 },
    );
    assert.strictEqual(result.termination, "output_limit");
    assert.isAtMost(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1_024);
  });

  it("force-kills a SIGTERM-ignoring process group at its timeout", async () => {
    const registry = new ExperimentProcessRegistry();
    const result = await registry.run(
      "run",
      ["node", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      {
        cwd: process.cwd(),
        timeoutMs: 25,
        maxOutputBytes: 1_024,
      },
    );
    assert.strictEqual(result.termination, "timeout");
  });

  it("cancel interrupts and awaits every owned process", async () => {
    const registry = new ExperimentProcessRegistry();
    const running = registry.run(
      "run",
      ["node", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 1_024 },
    );

    await registry.cancel("run");

    assert.strictEqual((await running).termination, "aborted");
  });

  it("force-kills descendants in the owned process group", async () => {
    const registry = new ExperimentProcessRegistry();
    const result = await registry.run(
      "run",
      [
        "node",
        "-e",
        "const{spawn}=require('child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)",
      ],
      { cwd: process.cwd(), timeoutMs: 250, maxOutputBytes: 1_024 },
    );
    assert.strictEqual(result.termination, "timeout");
  });
});
