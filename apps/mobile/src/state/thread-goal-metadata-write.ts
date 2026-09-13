/** Typed `/goal` writes have no editor epoch, which starts at 1. */
export const COMMAND_GOAL_WRITE = 0;

/** A reopened editor may supersede an older editor request, but not its own or a command write. */
export function canClaimThreadGoalMetadataWrite(
  currentOwner: number | null,
  editorEpoch: number,
): boolean {
  return currentOwner !== editorEpoch && currentOwner !== COMMAND_GOAL_WRITE;
}
