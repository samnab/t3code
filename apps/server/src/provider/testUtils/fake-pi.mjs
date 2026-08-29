/**
 * Minimal fake `pi` RPC binary used by focused Pi provider tests.
 * Spoken by `piRpc.test`/`PiAdapter.test`/`PiProvider.test` via a shell shim.
 *
 * Behavior is controlled by environment variables:
 *  - FAKE_PI_LOG — append every received record (one JSON per line) here.
 *  - FAKE_PI_SESSION_FILE — sessionFile reported by get_state.
 *  - FAKE_PI_VERSION — version reported for `--version`.
 *  - FAKE_PI_VETO — switch_session responds with { cancelled: true }.
 *  - FAKE_PI_SLOW_PROMPT_MS — delay before agent events for a normal prompt.
 *  - FAKE_PI_BUSY — get_state reports isStreaming true.
 */
import * as NodeFS from "node:fs";

const logPath = process.env.FAKE_PI_LOG;
const record = (r) => {
  if (logPath) NodeFS.appendFileSync(logPath, `${JSON.stringify(r)}\n`);
};
const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`${process.env.FAKE_PI_VERSION ?? "1.2.3"}\n`);
  process.exit(0);
}

record({ type: "launch", args });

let buffer = "";
const respond = (id, data) => send({ type: "response", id, success: true, data });

const handle = (req) => {
  record(req);
  switch (req.type) {
    case "get_state":
      respond(req.id, {
        sessionFile: process.env.FAKE_PI_SESSION_FILE ?? "/tmp/fake-pi/session.jsonl",
        model: { provider: "zai", id: "glm-5" },
        thinkingLevel: "high",
        isStreaming: process.env.FAKE_PI_BUSY === "1",
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
          { name: "review", description: "Review code" },
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
      send({ type: "agent_settled", aborted: true });
      respond(req.id, {});
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
      respond(req.id, {});
      if (message.startsWith("/only")) return; // command-only: no agent events
      const delay = Number(process.env.FAKE_PI_SLOW_PROMPT_MS ?? "10");
      setTimeout(() => {
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
        send({ type: "agent_settled" });
      }, delay);
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
