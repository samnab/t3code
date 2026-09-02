import { SUBAGENT_TRANSCRIPT_FIELD_MAX_CODE_POINTS } from "@t3tools/contracts";

const REDACTED = "[REDACTED]";

const SECRET_KEY = String.raw`(?:proxy-authorization|authorization|set-cookie|[a-z0-9_-]*(?:cookies?|api[-_ ]?key|oauth(?:[-_ ]?(?:token|access[-_ ]?token))?|proxy[-_ ]?token|secret|auth[-_]?token|access[-_]?token)[a-z0-9_-]*)`;

// Authorization values often contain a scheme plus credential. Consume both
// tokens without swallowing unrelated text later on the line.
const AUTHORIZATION_VALUE_PATTERN = new RegExp(
  String.raw`(\b(?:proxy-authorization|authorization)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:bearer|basic|token)\s+[^\s,;}"']+|[^\s,;}"']+)`,
  "gi",
);

// Cookie values may contain spaces and semicolon-delimited fields, so redact
// the complete header/assignment value instead of one token.
const COOKIE_VALUE_PATTERN = new RegExp(
  String.raw`(\b(?:set-cookie|cookies?)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)`,
  "gi",
);

// Covers headers, JSON-like fields, env assignments, and prose assignments.
// Quoted values are consumed whole; unquoted values stop at common structural
// delimiters so unrelated text remains readable.
const SECRET_VALUE_PATTERN = new RegExp(
  String.raw`(\b${SECRET_KEY}\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}"']+)`,
  "gi",
);

// Preserve the authentication scheme so the redacted text stays meaningful.
const AUTH_SCHEME_PATTERN = /\b(bearer|token)(\s+)[A-Za-z0-9._~+/-]{16,}/gi;

export const countCodePoints = (text: string) => Array.from(text).length;

export const redactSubagentTranscriptSecrets = (text: string) =>
  text
    .replace(AUTHORIZATION_VALUE_PATTERN, `$1${REDACTED}`)
    .replace(COOKIE_VALUE_PATTERN, `$1${REDACTED}`)
    .replace(SECRET_VALUE_PATTERN, `$1${REDACTED}`)
    .replace(AUTH_SCHEME_PATTERN, `$1$2${REDACTED}`);

const truncateCodePoints = (text: string, limit: number) => {
  const codePoints = Array.from(text);
  if (codePoints.length <= limit) {
    return { text, truncated: false } as const;
  }
  return { text: codePoints.slice(0, limit).join(""), truncated: true } as const;
};

export const sanitizeSubagentTranscriptField = (text: string, maxCodePoints: number) =>
  truncateCodePoints(redactSubagentTranscriptSecrets(text), maxCodePoints);

/**
 * Deterministic boundary sanitizer: redact first, then truncate by Unicode
 * code point. Upstream truncation remains a separate signal from T3's cap.
 */
export const sanitizeSubagentTranscriptText = (input: {
  readonly text: string;
  readonly upstreamTruncated: boolean;
}) => {
  const sanitized = sanitizeSubagentTranscriptField(
    input.text,
    SUBAGENT_TRANSCRIPT_FIELD_MAX_CODE_POINTS,
  );
  return {
    text: sanitized.text,
    truncated: sanitized.truncated,
    upstreamTruncated: input.upstreamTruncated,
  } as const;
};
