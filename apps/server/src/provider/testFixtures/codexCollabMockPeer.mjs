// Minimal codex app-server stand-in for runtime-level collab tests.
// Speaks just enough of the protocol for CodexSessionRuntime to start a
// session, using REAL captured responses (codexMultiAgentWire.json), then
// replays a scripted multi-agent notification sequence read from the
// T3_CODEX_COLLAB_SCRIPT env var (a JSON file path) when the first turn
// starts. Runs as a plain Node process — stdlib only.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "codexMultiAgentWire.json"), "utf8"),
);
const script = JSON.parse(NodeFS.readFileSync(process.env.T3_CODEX_COLLAB_SCRIPT, "utf8"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turnStartCount = 0;
let activeTurn;

const rl = NodeReadline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;
  if (method === undefined && script.serverRequests?.some((request) => request.id === id)) {
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.responses`,
      `${JSON.stringify({ id, result: message.result, error: message.error })}\n`,
    );
    if (script.completeTurnOnServerResponse && activeTurn) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: script.rootThreadId,
          turn: { ...activeTurn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-collab-mock/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "turn/start") {
    const turnId = script.turnIds?.[turnStartCount];
    const turn = turnId
      ? { ...fixture.responses.turnStart.turn, id: turnId }
      : fixture.responses.turnStart.turn;
    activeTurn = turn;
    turnStartCount += 1;
    write({ id, result: { ...fixture.responses.turnStart, turn } });
    const rootThreadId = script.rootThreadId;
    if (script.onlyFirstTurnStarts !== true || turnStartCount === 1) {
      write({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: rootThreadId, turn },
      });
    }
    for (const notification of script.notifications) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    for (const request of script.serverRequests ?? []) {
      write({ jsonrpc: "2.0", id: request.id, method: request.method, params: request.params });
    }
    if (script.holdTurnOpen !== true) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: rootThreadId,
          turn: { ...turn, status: "completed" },
        },
      });
    }
    return;
  }
  if (
    method === "thread/goal/get" ||
    method === "thread/goal/set" ||
    method === "thread/goal/clear"
  ) {
    // Record the exact goal request (sidecar file the test reads), then
    // answer from the script: goalGet is the ThreadGoal (or null),
    // goalMethodNotFound simulates an outdated Codex binary.
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.goalCalls`,
      `${JSON.stringify({ method, params: message.params })}\n`,
    );
    if (script.goalMethodNotFound === true) {
      write({ id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    if (method === "thread/goal/get") {
      write({ id, result: { goal: script.goalGet ?? null } });
      return;
    }
    if (method === "thread/goal/set") {
      const goal = script.goalGet ?? {
        threadId: message.params?.threadId,
        objective: "ship the fix",
        status: "paused",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1776272400,
        updatedAt: 1776272460,
      };
      write({ id, result: { goal: { ...goal, status: message.params?.status ?? goal.status } } });
      return;
    }
    write({ id, result: { cleared: true } });
    return;
  }
  if (method === "thread/compact/start") {
    // Record the exact compact request (sidecar file the test reads) and
    // answer like the real app server: accept immediately, then signal the
    // compact turn's completion asynchronously.
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.compacts`,
      `${JSON.stringify({ threadId: message.params?.threadId })}\n`,
    );
    write({ id, result: {} });
    // The current protocol signals the finished compact turn as a completed
    // `contextCompaction` item; `thread/compacted` is the deprecated shape.
    // compactionSignal scripts which shape(s) the peer emits: "notification"
    // (default, legacy), "item", or "both" (transition overlap).
    const compactionSignal = script.compactionSignal ?? "notification";
    if (compactionSignal === "notification" || compactionSignal === "both") {
      write({
        jsonrpc: "2.0",
        method: "thread/compacted",
        params: { threadId: message.params?.threadId, turnId: "compact-turn-1" },
      });
    }
    if (compactionSignal === "item" || compactionSignal === "both") {
      write({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          threadId: message.params?.threadId,
          turnId: "compact-turn-1",
          completedAtMs: 1_778_000_000_000,
          item: { id: "item-context-compaction-1", type: "contextCompaction" },
        },
      });
    }
    return;
  }
  if (method === "turn/interrupt") {
    // Record which thread/turn was interrupted (append-only sidecar file the
    // test reads) so Stop coverage can assert every live child was reached.
    // failInterruptFor simulates a dead child whose interrupt errors.
    const target = message.params?.threadId;
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.interrupts`,
      `${JSON.stringify({ threadId: target, turnId: message.params?.turnId })}\n`,
    );
    if (
      script.expectedActiveTurnId &&
      message.params?.threadId === script.rootThreadId &&
      message.params?.turnId !== script.expectedActiveTurnId
    ) {
      write({
        id,
        error: {
          code: -32000,
          message: `expected active turn id ${message.params?.turnId} but found ${script.expectedActiveTurnId}`,
        },
      });
      return;
    }
    if (script.failInterruptFor && script.failInterruptFor === target) {
      write({ id, error: { code: -32000, message: "thread already closed" } });
      return;
    }
    if (script.hangInterruptFor && script.hangInterruptFor === target) {
      // Never respond: simulates a wedged child whose RPC neither resolves
      // nor rejects. The runtime's bounded deadline must move on.
      return;
    }
    write({ id, result: {} });
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
