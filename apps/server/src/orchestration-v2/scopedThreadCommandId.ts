import { CommandId, type ThreadId } from "@t3tools/contracts";

/** Keep the metadata command receipt format stable for existing caller retry keys. */
export function scopedThreadCommandId(input: {
  readonly requestNamespace: string;
  readonly threadId: ThreadId;
  readonly action: string;
  readonly requestKey: string;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      encodeURIComponent(input.requestNamespace),
      "thread-update",
      encodeURIComponent(input.threadId),
      encodeURIComponent(input.action),
      encodeURIComponent(input.requestKey),
    ].join(":"),
  );
}
