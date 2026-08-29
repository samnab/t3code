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
      respond(req.id, {});
      return;
    case "extension_ui_response":
      if (String(req.id).startsWith("ui-")) {
        uiResponses += 1;
        if (uiResponses === 3) {
          isStreaming = false;
          send({ type: "agent_settled" });
        }
      }
      return;
    case "prompt": {
      const message = String(req.message ?? "");
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
      if (message === "UI_ROUNDTRIP") {
        isStreaming = true;
        send({ type: "agent_start" });
        for (const method of ["select", "input", "editor"]) {
          send({
            type: "extension_ui_request",
            id: `ui-${method}`,
            method,
            message: `${method} question`,
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
