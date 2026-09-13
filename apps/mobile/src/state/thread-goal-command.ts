import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { parseThreadGoalCommand, type ThreadGoalCommand } from "@t3tools/shared/composerTrigger";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import {
  resolveThreadGoalCommandBlockReason,
  type ThreadGoalCommandBlockReason,
} from "@t3tools/client-runtime/state/threadGoalEditor";

export function resolveComposerThreadGoalCommand(input: {
  readonly text: string;
  readonly attachmentCount: number;
  readonly context?: OrchestrationMessageContext;
  readonly capabilityKnown: boolean;
  readonly supportsThreadGoals: boolean;
}): {
  readonly command: ThreadGoalCommand;
  readonly blockReason: ThreadGoalCommandBlockReason | null;
} | null {
  const command = parseThreadGoalCommand(replaceComposerContextReferences(input.text, () => ""));
  if (command === null) return null;
  return {
    command,
    blockReason: resolveThreadGoalCommandBlockReason({
      isServerThread: true,
      attachmentCount: input.attachmentCount,
      contextCount: input.context?.records.length ?? 0,
      capabilityKnown: input.capabilityKnown,
      supportsThreadGoals: input.supportsThreadGoals,
    }),
  };
}
