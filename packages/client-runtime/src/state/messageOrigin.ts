import type { OrchestrationMessageOrigin } from "@t3tools/contracts";

/**
 * Server-authored role: "user" messages (subagent deliveries, goal-continue
 * prompts) carry an `origin` tag so clients can tell them apart from words
 * the human actually typed. Any predicate that means "the user's own
 * message" (edit/resend targets, minimap previews, empty-state checks) must
 * exclude these; turn-boundary logic should not, since they do start a real
 * turn server-side.
 */
export function isServerAuthoredMessage(message: { origin?: OrchestrationMessageOrigin }): boolean {
  return message.origin !== undefined;
}

export interface ParsedSubagentDeliveryHeader {
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly runId: string;
  readonly body: string;
}

const SUBAGENT_DELIVERY_HEADER_RE =
  /^\[T3 subagent result: ([\s\S]+) \(([^/,()]+)\/([^,()]+), ([^,()]+), run ([^()]+)\)\]\n?([\s\S]*)$/;

/**
 * Parses the fixed header line ChildRunService.deliveryText writes:
 * `[T3 subagent result: <title> (<provider>/<model>, <status>, run <runId>)]`
 * followed by the child's output. Returns null on any shape mismatch so
 * callers can fall back to a plain label instead of showing garbled text.
 */
export function parseSubagentDeliveryText(text: string): ParsedSubagentDeliveryHeader | null {
  const match = SUBAGENT_DELIVERY_HEADER_RE.exec(text);
  if (!match) return null;
  const [, title, provider, model, status, runId, body] = match;
  if (!title || !provider || !model || !status || !runId) return null;
  return { title, provider, model, status, runId, body: body ?? "" };
}
