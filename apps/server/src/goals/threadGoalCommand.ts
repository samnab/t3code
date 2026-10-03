export type ThreadGoalCommand =
  | { readonly action: "show" }
  | { readonly action: "clear" }
  | { readonly action: "set"; readonly goal: string };

const SEPARATOR = "\\p{White_Space}";
const COMMAND = new RegExp(`^/goal(?:${SEPARATOR}+([\\s\\S]*))?$`, "iu");
const LEADING = new RegExp(`^${SEPARATOR}+`, "u");
const TRAILING = new RegExp(`${SEPARATOR}+$`, "u");

function trimGoalWhitespace(text: string): string {
  return text.replace(LEADING, "").replace(TRAILING, "");
}

/** Recognizes only T3's standard goal commands. Restricted experiments stay deferred. */
export function parseThreadGoalCommand(text: string): ThreadGoalCommand | null {
  const match = COMMAND.exec(trimGoalWhitespace(text));
  if (!match) return null;
  const rest = trimGoalWhitespace(match[1] ?? "");
  if (rest === "") return { action: "show" };
  if (/^clear$/i.test(rest)) return { action: "clear" };
  return { action: "set", goal: rest };
}
