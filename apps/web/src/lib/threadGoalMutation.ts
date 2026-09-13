import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

const activeThreadGoalMutations = new Set<string>();

export type ThreadGoalMutationResult<T> =
  | { readonly status: "busy" }
  | { readonly status: "completed"; readonly value: T };

/** Runs one goal metadata mutation per thread, including any lifecycle work before the write. */
export async function runThreadGoalMutation<T>(
  threadRef: ScopedThreadRef,
  mutation: () => Promise<T>,
): Promise<ThreadGoalMutationResult<T>> {
  const threadKey = scopedThreadKey(threadRef);
  if (activeThreadGoalMutations.has(threadKey)) return { status: "busy" };

  activeThreadGoalMutations.add(threadKey);
  try {
    return { status: "completed", value: await mutation() };
  } finally {
    activeThreadGoalMutations.delete(threadKey);
  }
}
