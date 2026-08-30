/**
 * Minimal fake `pi` RPC binary used by focused Pi provider tests.
 * Spoken by `piRpc.test`/`PiAdapter.test`/`PiProvider.test` via a shell shim.
 *
 * Behavior is controlled by environment variables:
 *  - FAKE_PI_LOG — append every received record (one JSON per line) here.
 *  - FAKE_PI_CLOSED — touch this file when the process receives SIGTERM.
 *  - FAKE_PI_SESSION_FILE — sessionFile reported by get_state.
 *  - FAKE_PI_VERSION — version reported for `--version`.
 *  - FAKE_PI_VETO — switch_session responds with { cancelled: true }.
 *  - FAKE_PI_FAIL_COMMAND — return a failed response for this command type.
 *  - FAKE_PI_BUSY — get_state reports isStreaming true.
 *  - FAKE_PI_MANAGER — register the T3 subagent manager control command and
 *    speak the t3.subagent.v1 stdout JSON contract.
 *  - FAKE_PI_MANAGER_ID — managerId reported during negotiation.
 *  - FAKE_PI_MANAGER_CAPABILITIES — JSON patch over all-true capability flags.
 *  - FAKE_PI_MANAGER_REJECT_FILE — when this file exists, ack steer/cancel
 *    envelopes with accepted:false.
 */
import * as NodeFS from "node:fs";

const logPath = process.env.FAKE_PI_LOG;
const record = (value) => {
  if (logPath) NodeFS.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
};
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? "1.2.3"}\n`);
  process.exit(0);
}

const markClosed = () => {
  const closedPath = process.env.FAKE_PI_CLOSED;
  if (closedPath) NodeFS.writeFileSync(closedPath, "closed");
};
process.on("SIGTERM", () => {
  markClosed();
  process.exit(0);
});

record({ type: "launch", args });

let buffer = "";
let interleavedRun = false;
let isStreaming = false;
let uiResponses = 0;
let waitForExtensionCancellation = false;
let pendingAbortRequest;
const respond = (id, data) => send({ type: "response", id, success: true, data });
const reject = (req, error) =>
  send({ type: "response", id: req.id, command: req.type, success: false, error });

const emitAgentRun = () => {
  isStreaming = true;
  const messageId = "msg-1";
  send({ type: "agent_start" });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      messageId,
      contentIndex: 0,
      delta: "Hello ",
    },
  });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      messageId,
      contentIndex: 0,
      delta: "world",
    },
  });
  send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  send({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "echo hi" },
  });
  send({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "echo hi" },
  });
  isStreaming = false;
  send({ type: "agent_settled" });
};

const subagentDetails = (status = "running") => ({
  id: "sa-1",
  title: "map auth",
  cwd: process.cwd(),
  harness: "pi",
  model: "zai/glm-5.3-flash",
  status,
  trusted_suborch: false,
});

// ── fake T3 subagent manager ──

const MANAGER_COMMAND = "subagent:t3-control";
const MANAGER_RECORD_TYPE = "t3.subagent.v1";
const managerId = () => process.env.FAKE_PI_MANAGER_ID ?? "fake-manager-1";
const managerEnabled = () => process.env.FAKE_PI_MANAGER === "1";

const managerRecord = (value) => send({ type: MANAGER_RECORD_TYPE, ...value });

const negotiatedCapabilities = () => ({
  normalizedEvents: true,
  stableActivations: true,
  ownerRouting: true,
  steering: true,
  cancellation: true,
  reloadRestore: true,
  scheduling: true,
  nativeChildProjection: true,
  deliveryAcknowledgements: true,
  ...JSON.parse(process.env.FAKE_PI_MANAGER_CAPABILITIES ?? "{}"),
});

const handleManagerControl = (req, message) => {
  const arg = message.slice(`/${MANAGER_COMMAND} `.length).trim();
  let envelope;
  try {
    envelope = JSON.parse(Buffer.from(arg, "base64url").toString("utf8"));
  } catch {
    return;
  }
  if (envelope.op === "negotiate") {
    managerRecord({
      kind: "negotiation",
      id: envelope.id,
      managerId: managerId(),
      protocolVersion: 1,
      capabilities: negotiatedCapabilities(),
    });
    return;
  }
  if (envelope.op === "steer" || envelope.op === "cancel") {
    const rejectFile = process.env.FAKE_PI_MANAGER_REJECT_FILE;
    if (rejectFile !== undefined && NodeFS.existsSync(rejectFile)) {
      managerRecord({
        kind: "ack",
        id: envelope.id,
        accepted: false,
        error: `fake manager refused ${envelope.op}`,
      });
      return;
    }
    managerRecord({ kind: "ack", id: envelope.id, accepted: true });
  }
};

const managerUpsert = (fields) =>
  managerRecord({ kind: "run-upsert", managerId: managerId(), ...fields });

// Manager-global sequence: every record advances one sequence, across runs.
// act-1: start(1) → update(2) → complete(3); then rejected stale, late, and
// wrong-owner records; act-2 starts at (5); act-3 then supersedes the
// still-live act-2 at (6).
const emitManagerLifecycle = () => {
  const mid = managerId();
  const upsert = (fields) => managerRecord({ kind: "run-upsert", managerId: mid, ...fields });
  upsert({
    sequence: 1,
    runId: "sa-1",
    activationId: "act-1",
    status: "running",
    title: "map auth",
    harness: "pi",
    model: "zai/glm-5.3-flash",
  });
  upsert({
    sequence: 2,
    runId: "sa-1",
    activationId: "act-1",
    status: "running",
    title: "map auth",
  });
  upsert({
    sequence: 3,
    runId: "sa-1",
    activationId: "act-1",
    status: "done",
    summary: "Mapped the auth flow.",
  });
  upsert({
    sequence: 3,
    runId: "sa-1",
    activationId: "act-1",
    status: "done",
    summary: "duplicate terminal",
  });
  upsert({ sequence: 2, runId: "sa-1", activationId: "act-1", status: "running" });
  upsert({ sequence: 4, runId: "sa-1", activationId: "act-1", status: "running" });
  upsert({
    managerId: "rogue-manager",
    sequence: 9,
    runId: "sa-9",
    activationId: "act-9",
    status: "running",
  });
  upsert({
    sequence: 5,
    runId: "sa-1",
    activationId: "act-2",
    status: "running",
    title: "map auth, again",
  });
  upsert({
    sequence: 6,
    runId: "sa-1",
    activationId: "act-3",
    status: "running",
    title: "map auth, third",
  });
};

const emitSubagentSpawnStart = () =>
  send({
    type: "tool_execution_start",
    toolCallId: "spawn-1",
    toolName: "subagent_spawn",
    args: { name: "map auth", harness: "pi" },
  });

const emitSubagentSpawnEnd = (status = "running") =>
  send({
    type: "tool_execution_end",
    toolCallId: "spawn-1",
    toolName: "subagent_spawn",
    args: { name: "map auth", harness: "pi" },
    result: {
      content: [{ type: "text", text: "Spawned subagent sa-1." }],
      details: subagentDetails(status),
    },
    isError: false,
  });

const subagentResultEntry = (status, content, id = "sa-1") => ({
  type: "custom",
  customType: "subagent-result",
  data: { id, title: "map auth", status, content },
});

const emitConsumedSubagentResult = (toolName, status) => {
  send({
    type: "tool_execution_start",
    toolCallId: `${toolName}-1`,
    toolName,
    args: { ids: ["sa-1"] },
  });
  send({
    type: "tool_execution_end",
    toolCallId: `${toolName}-1`,
    toolName,
    args: { ids: ["sa-1"] },
    result: {
      content: [{ type: "text", text: `${toolName} collected sa-1.` }],
      details: {
        results: [
          {
            id: "sa-1",
            title: "map auth",
            status,
            ...(toolName === "subagent_wait" ? { collection: "collected" } : {}),
          },
        ],
      },
    },
    isError: false,
  });
};

const handle = (req) => {
  record(req);
  if (process.env.FAKE_PI_FAIL_COMMAND === req.type) {
    reject(req, `fake ${req.type} failure`);
    return;
  }
  switch (req.type) {
    case "get_state":
      respond(req.id, {
        sessionFile: process.env.FAKE_PI_SESSION_FILE ?? "/tmp/fake-pi/session.jsonl",
        model: { provider: "zai", id: "glm-5" },
        thinkingLevel: "high",
        isStreaming: process.env.FAKE_PI_BUSY === "1" || isStreaming,
        isCompacting: false,
        pendingMessageCount: 0,
      });
      return;
    case "get_available_models":
      respond(req.id, {
        models: [
          {
            provider: "zai",
            id: "glm-5",
            name: "GLM 5",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh" },
          },
          { provider: "zai", id: "glm-5-flash", name: "GLM 5 Flash", reasoning: false },
        ],
      });
      return;
    case "get_commands":
      respond(req.id, {
        commands: [
          { name: "review", description: "Review code", source: "extension" },
          { name: "only", description: "Command-only fixture", source: "extension" },
          { name: "template", description: "Prompt template fixture", source: "prompt" },
          ...(managerEnabled()
            ? [
                {
                  name: MANAGER_COMMAND,
                  description: "T3 subagent control plane",
                  source: "extension",
                },
              ]
            : []),
          {
            name: "skill:research",
            source: "skill",
            sourceInfo: { path: "/skills/research", scope: "personal" },
          },
        ],
      });
      return;
    case "switch_session":
      if (process.env.FAKE_PI_VETO === "1") {
        respond(req.id, { cancelled: true });
        return;
      }
      respond(req.id, {});
      return;
    case "set_model":
      respond(req.id, {});
      return;
    case "abort":
      isStreaming = false;
      send({ type: "agent_settled", aborted: true });
      if (waitForExtensionCancellation) {
        pendingAbortRequest = req;
        return;
      }
      respond(req.id, {});
      return;
    case "extension_ui_response":
      if (req.id === "ui-abort" && req.cancelled === true && pendingAbortRequest !== undefined) {
        respond(pendingAbortRequest.id, {});
        waitForExtensionCancellation = false;
        pendingAbortRequest = undefined;
        return;
      }
      if (String(req.id).startsWith("ui-")) {
        uiResponses += 1;
        if (uiResponses === 4) {
          isStreaming = false;
          send({ type: "agent_settled" });
        }
      }
      return;
    case "prompt": {
      const message = String(req.message ?? "");
      if (managerEnabled() && message.startsWith(`/${MANAGER_COMMAND} `)) {
        handleManagerControl(req, message);
        send({ type: "response", id: req.id, command: "prompt", success: true });
        return;
      }
      if (message === "MANAGER_RUN_LIFECYCLE" || message === "MANAGER_RUN_OPEN") {
        send({ type: "response", id: req.id, command: "prompt", success: true });
        if (message === "MANAGER_RUN_LIFECYCLE") {
          emitManagerLifecycle();
        } else {
          managerUpsert({
            sequence: 1,
            runId: "sa-1",
            activationId: "act-1",
            status: "running",
            title: "map auth",
            harness: "pi",
            model: "zai/glm-5.3-flash",
          });
        }
        send({ type: "agent_settled" });
        return;
      }
      if (message.includes("REJECT")) {
        send({
          type: "response",
          success: false,
          command: "prompt",
          error: "pi rejected the prompt",
        });
        return;
      }
      send({ type: "response", id: req.id, command: "prompt", success: true });
      if (message.startsWith("/only")) return;
      if (message === "WAIT_FOR_ABORT") {
        isStreaming = true;
        send({ type: "agent_start" });
        return;
      }
      if (message === "UI_WAIT_FOR_ABORT") {
        isStreaming = true;
        waitForExtensionCancellation = true;
        send({ type: "agent_start" });
        send({
          type: "extension_ui_request",
          id: "ui-abort",
          method: "confirm",
          title: "Confirm action",
          message: "Keep waiting?",
        });
        return;
      }
      if (message === "UI_ROUNDTRIP") {
        isStreaming = true;
        send({ type: "agent_start" });
        send({
          type: "extension_ui_request",
          id: "ui-select",
          method: "select",
          title: "Choose access",
          options: ["Allow", "Deny"],
        });
        send({
          type: "extension_ui_request",
          id: "ui-input",
          method: "input",
          title: "Enter a value",
          placeholder: "Type a value",
        });
        send({
          type: "extension_ui_request",
          id: "ui-editor",
          method: "editor",
          title: "Edit the value",
          prefill: "Starting value",
        });
        send({
          type: "extension_ui_request",
          id: "ui-confirm",
          method: "confirm",
          title: "Confirm action",
          message: "Continue with the extension?",
        });
        return;
      }
      if (message === "SUBAGENT_TOOL_AND_MANAGER") {
        // Tool-result projection AND normalized manager events for the same
        // run: the manager path must win and the tool path must not duplicate.
        isStreaming = true;
        send({ type: "agent_start" });
        emitSubagentSpawnStart();
        emitSubagentSpawnEnd();
        managerUpsert({
          sequence: 1,
          runId: "sa-1",
          activationId: "act-1",
          status: "running",
          title: "map auth",
          harness: "pi",
          model: "zai/glm-5.3-flash",
        });
        isStreaming = false;
        send({ type: "agent_settled" });
        return;
      }
      if (message.startsWith("SUBAGENT_")) {
        isStreaming = true;
        send({ type: "agent_start" });
        emitSubagentSpawnStart();

        if (message === "SUBAGENT_TERMINAL_RACE") {
          send({
            type: "entry_appended",
            entry: subagentResultEntry("done", "Won the registration race."),
          });
          emitSubagentSpawnEnd();
        } else if (message === "SUBAGENT_SPAWN_DONE") {
          emitSubagentSpawnEnd("done");
        } else if (message === "SUBAGENT_SPAWN_ERROR") {
          emitSubagentSpawnEnd("error");
        } else {
          emitSubagentSpawnEnd();
        }

        if (message === "SUBAGENT_WAIT_CONSUMED") {
          emitConsumedSubagentResult("subagent_wait", "done");
        } else if (message === "SUBAGENT_WAIT_ERROR_CONSUMED") {
          emitConsumedSubagentResult("subagent_wait", "error");
        } else if (message === "SUBAGENT_CANCEL_CONSUMED") {
          emitConsumedSubagentResult("subagent_cancel", "error");
        }

        isStreaming = false;
        send({ type: "agent_settled" });
        if (message === "SUBAGENT_LIFECYCLE") {
          setImmediate(() => {
            send({
              type: "entry_appended",
              entry: subagentResultEntry("done", "ignore me", "forged"),
            });
            const entry = subagentResultEntry("done", "  Mapped the auth flow.  ");
            send({ type: "entry_appended", entry });
            send({ type: "entry_appended", entry });
          });
        } else if (message === "SUBAGENT_OVERSIZED") {
          setImmediate(() => {
            send({
              type: "entry_appended",
              entry: subagentResultEntry("done", `${"😀".repeat(4_095)}x${" ".repeat(70_000)}`),
            });
          });
        }
        return;
      }
      if (message.includes("INTERLEAVE")) {
        isStreaming = true;
        interleavedRun = true;
        send({ type: "agent_start" });
        send({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            messageId: "msg-1",
            contentIndex: 0,
            delta: "A ",
          },
        });
        return;
      }
      if (interleavedRun && req.streamingBehavior === "steer") {
        interleavedRun = false;
        send({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            messageId: "msg-1",
            contentIndex: 0,
            delta: "done",
          },
        });
        send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        isStreaming = false;
        send({ type: "agent_settled" });
        return;
      }
      // Pi acknowledges accepted prompts before agent_start. setImmediate keeps
      // that protocol boundary deterministic without a timing delay.
      setImmediate(emitAgentRun);
      return;
    }
    default:
      respond(req.id, {});
  }
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Drop malformed input like the real transport does.
    }
  }
});
process.stdin.on("end", () => process.exit(0));
