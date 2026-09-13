export type ComposerTriggerKind =
  | "path"
  | "pull-request"
  | "slash-command"
  | "slash-model"
  | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/**
 * Detect an active trigger (@path, $skill, /command) at the cursor position.
 *
 * Accepts an optional `isWhitespaceChar` override so callers with inline
 * placeholder characters (e.g. terminal context chips on web) can treat
 * those as token boundaries.
 */
export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch)
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export type ThreadGoalCommand =
  | { readonly action: "show" }
  | { readonly action: "clear" }
  | { readonly action: "experiment"; readonly objective: string }
  | { readonly action: "set"; readonly goal: string };

// The /goal delimiter policy, in one place so acceptance and trimming cannot
// drift: exactly the Unicode White_Space code points (space, tab, LF, CRLF,
// NBSP, and friends). Formatting characters that merely render as nothing —
// U+200B ZERO WIDTH SPACE, U+FEFF BOM, U+2060 WORD JOINER — are NOT
// separators, and unlike String.trim they are not outer whitespace either,
// so a zero-width-joined `/goal\uFEFF…` stays an ordinary prompt and a goal
// keeps them verbatim at its edges.
const THREAD_GOAL_SEPARATOR = "\\p{White_Space}";
const THREAD_GOAL_COMMAND_REGEX = new RegExp(
  `^/goal(?:${THREAD_GOAL_SEPARATOR}+([\\s\\S]*))?$`,
  "iu",
);
const THREAD_GOAL_LEADING_WHITESPACE = new RegExp(`^${THREAD_GOAL_SEPARATOR}+`, "u");
const THREAD_GOAL_TRAILING_WHITESPACE = new RegExp(`${THREAD_GOAL_SEPARATOR}+$`, "u");
const THREAD_GOAL_EXPERIMENT_REGEX = new RegExp(
  `^experiment(?:${THREAD_GOAL_SEPARATOR}+([\\s\\S]*))?$`,
  "iu",
);

export function trimThreadGoalWhitespace(text: string): string {
  return text
    .replace(THREAD_GOAL_LEADING_WHITESPACE, "")
    .replace(THREAD_GOAL_TRAILING_WHITESPACE, "");
}

// A goal payload must contain at least one visible character. White_Space
// separators and the formatting marks the delimiter policy excludes
// (U+200B, U+FEFF, U+2060) render as nothing, so a payload made only of
// them would persist an invisible goal. Scripts, emoji, and combining text
// all pass untouched. Clients reject before any metadata RPC; empty strings
// also fail.
const INVISIBLE_THREAD_GOAL_CHARS = /^[\p{White_Space}\u200B\uFEFF\u2060]*$/u;

export function hasVisibleThreadGoalText(text: string): boolean {
  return !INVISIBLE_THREAD_GOAL_CHARS.test(text);
}

// `/goal` alone shows the current goal; `/goal clear` clears it and `/goal
// experiment <objective>` starts the reviewed experiment flow. Reserved words
// are case-insensitive like other built-ins. A missing experiment objective is
// returned explicitly so a client can show validation instead of treating the
// reserved word as an ordinary goal. Any other remainder is the new goal text.
// This parser is also the shared provider-dispatch guard, so web, mobile, and
// the server recognize the same command set.
export function parseThreadGoalCommand(text: string): ThreadGoalCommand | null {
  const match = THREAD_GOAL_COMMAND_REGEX.exec(trimThreadGoalWhitespace(text));
  if (!match) {
    return null;
  }
  const rest = trimThreadGoalWhitespace(match[1] ?? "");
  if (rest === "") {
    return { action: "show" };
  }
  if (/^clear$/i.test(rest)) {
    return { action: "clear" };
  }
  const experiment = THREAD_GOAL_EXPERIMENT_REGEX.exec(rest);
  if (experiment) {
    return {
      action: "experiment",
      objective: trimThreadGoalWhitespace(experiment[1] ?? ""),
    };
  }
  return { action: "set", goal: rest };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
