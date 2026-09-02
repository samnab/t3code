/**
 * T3-boundary sanitization for enhanced-manager child transcript text.
 *
 * Redaction-then-truncation: secrets are replaced before the per-field
 * Unicode-code-point cap is applied, so a truncated field can never carry the
 * tail of a secret that the cap would have split. The producer is expected to
 * redact first too; T3 runs this again before side-store persistence because
 * the boundary that stores the bytes is the one that must guarantee it.
 *
 * @module persistence/subagentTranscriptSanitization
 */

const REDACTED = "[REDACTED]";

/**
 * Secret-bearing shapes covered at the T3 boundary: authorization and
 * proxy-authorization headers (with or without a scheme), cookies, API keys,
 * OAuth tokens, proxy tokens, and secret-named header values. Matching is
 * case-insensitive and value-greedy up to whitespace or a delimiter.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // authorization: bearer <token> / proxy-authorization: basic <cred>. The
  // scheme word must be followed by whitespace so the value, never the
  // scheme alone, is what gets redacted.
  /\b(?:proxy-)?authorization\b(\s*[:=]\s*)(?:(?:bearer|basic|token|dpop|mac)\s+)?[^\s,;"]+/gi,
  // bare bearer/token schemes used in prose and tool output
  /\b(?:bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  // api key / apikey assignments
  /\bapi[-_]?key\b(\s*[:=]\s*)[^\s,;"']+/gi,
  // oauth / proxy token assignments
  /\b(?:oauth|proxy)[-_]?token\b(\s*[:=]\s*)[^\s,;"']+/gi,
  // cookie headers and set-cookie pairs
  /\bcookies?(\s*[:=]\s*)[^\r\n]+/gi,
  // secret-flavored header names, e.g. x-api-key, x-auth-token, x-secret-key
  /\b[a-z0-9]+-(?:api[-_]?key|auth[-_]?token|secret(?:[-_]?key)?|access[-_]?token)\b(\s*[:=]\s*)[^\s,;"']+/gi,
];

/** Replace secret-shaped values in observed text. Order-safe and idempotent. */
export function redactSubagentTranscriptSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, separator: string | undefined) => {
      // Whole-token matches (bare bearer schemes) redact the long token only;
      // header-shaped matches keep their name and separator, redacting the value.
      if (separator === undefined) {
        return match.replace(/[A-Za-z0-9._~+/=-]{16,}$/, REDACTED);
      }
      const prefixLength = match.indexOf(separator) + separator.length;
      return `${match.slice(0, prefixLength)}${REDACTED}`;
    });
  }
  return redacted;
}

/** Count Unicode code points without materializing an array. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (const _codePoint of text) count += 1;
  return count;
}

function truncateToCodePoints(text: string, limit: number): string {
  let codePoints = 0;
  let end = 0;
  for (const codePoint of text) {
    if (codePoints >= limit) break;
    codePoints += 1;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

export interface SanitizedSubagentTranscriptField {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Redact, then enforce the per-field code-point cap. `upstreamTruncated` is
 * carried by the caller: v1 accepts that upstream truncation may have split
 * secret-shaped text before T3 ever saw it.
 */
export function sanitizeSubagentTranscriptField(
  text: string,
  maxCodePoints: number,
): SanitizedSubagentTranscriptField {
  const redacted = redactSubagentTranscriptSecrets(text);
  const truncated = countCodePoints(redacted) > maxCodePoints;
  return {
    text: truncated ? truncateToCodePoints(redacted, maxCodePoints) : redacted,
    truncated,
  };
}
