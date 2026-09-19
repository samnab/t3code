import type { OrchestrationMessage } from "@t3tools/contracts";

/** Rough transcript ceiling; when it is hit the most recent messages win. */
const MAX_TRANSCRIPT_CHARACTERS = 24_000;

const HANDOFF_HEADER = [
  "<provider_handoff>",
  "You are taking over a conversation that was previously handled by a different agent in this same workspace. The transcript below is context only. The user's new message follows the transcript.",
  "</provider_handoff>",
].join("\n");

/**
 * Renders the user/assistant transcript of a started thread for the first
 * turn after switching to a provider instance that cannot resume the previous
 * native session. Returns null when there is nothing to hand over, so the
 * caller skips the prepend entirely.
 */
export function buildProviderHandoffTranscript(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text">>,
): string | null {
  const blocks = messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0,
    )
    .map((message) => `[${message.role}]\n${message.text.trim()}`);
  if (blocks.length === 0) {
    return null;
  }
  // Walk newest to oldest so the cap always keeps the most recent messages;
  // the newest block is kept even when it alone exceeds the cap.
  const kept: Array<string> = [];
  let total = 0;
  let index = blocks.length - 1;
  while (index >= 0) {
    const block = blocks[index];
    if (
      block === undefined ||
      (kept.length > 0 && total + block.length > MAX_TRANSCRIPT_CHARACTERS)
    ) {
      break;
    }
    kept.unshift(block);
    total += block.length;
    index -= 1;
  }
  return [
    HANDOFF_HEADER,
    ...(index >= 0 ? ["(earlier messages omitted)"] : []),
    kept.join("\n\n"),
  ].join("\n\n");
}
