import type { OrchestrationMessage } from "@t3tools/contracts";

// Server-authored role: "user" messages (subagent delivery, goal-loop continue)
// that should never be treated as the user's own words: not a real user
// bubble, not a signal of user activity for sorting/anchoring/turn-boundary
// heuristics.
// ponytail: duplicated from a similar parser the web lane may add at
// packages/client-runtime/src/state/messageOrigin.ts — dedupe into that
// shared module once it lands.
export function isOriginMessage(message: Pick<OrchestrationMessage, "origin">): boolean {
  return message.origin !== undefined;
}

const SUBAGENT_DELIVERY_HEADER =
  /^\[T3 subagent result: (?<title>.+?) \((?<provider>.+?)\/(?<model>.+?), (?<status>.+?), run (?<runId>.+?)\)\]\n?/;

export interface SubagentDeliveryHeader {
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly runId: string;
  readonly body: string;
}

export function parseSubagentDeliveryHeader(text: string): SubagentDeliveryHeader | null {
  const match = SUBAGENT_DELIVERY_HEADER.exec(text);
  if (!match?.groups) {
    return null;
  }
  return {
    title: match.groups.title ?? "",
    provider: match.groups.provider ?? "",
    model: match.groups.model ?? "",
    status: match.groups.status ?? "",
    runId: match.groups.runId ?? "",
    body: text.slice(match[0].length),
  };
}
