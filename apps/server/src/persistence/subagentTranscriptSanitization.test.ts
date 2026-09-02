import { describe, expect, it } from "@effect/vitest";

import {
  countCodePoints,
  redactSubagentTranscriptSecrets,
  sanitizeSubagentTranscriptField,
} from "./subagentTranscriptSanitization.ts";

describe("subagentTranscriptSanitization", () => {
  it("redacts authorization, cookie, API-key, OAuth, proxy-token, and secret-header values", () => {
    const redacted = redactSubagentTranscriptSecrets(
      [
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token",
        "proxy-authorization: Basic dXNlcjpwYXNzMTIz==",
        "Cookie: session=abc123; theme=dark",
        "api_key=sk-live-0123456789abcdef",
        "oauth_token=ya29.a0AfH6SMBx123456",
        "x-api-key: very-secret-key-value-987",
        "X-Secret-Key=hunter2hunter2hunter2",
        "ANTHROPIC_API_KEY=anthropic-prefixed-secret",
        "OPENAI_API_KEY=openai-prefixed-secret",
        "ZAI_API_KEY=zai-prefixed-secret",
        "GITHUB_API_KEY=github-prefixed-secret",
        "HTTP_PROXY_TOKEN=proxy-prefixed-secret",
        "SESSION_COOKIE=session-prefixed-secret",
        "clean text stays: the api key was rotated",
      ].join("\n"),
    );
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("dXNlcjpwYXNzMTIz");
    expect(redacted).not.toContain("session=abc123");
    expect(redacted).not.toContain("sk-live-0123456789abcdef");
    expect(redacted).not.toContain("ya29.a0AfH6SMBx123456");
    expect(redacted).not.toContain("very-secret-key-value-987");
    expect(redacted).not.toContain("hunter2hunter2hunter2");
    expect(redacted).not.toContain("anthropic-prefixed-secret");
    expect(redacted).not.toContain("openai-prefixed-secret");
    expect(redacted).not.toContain("zai-prefixed-secret");
    expect(redacted).not.toContain("github-prefixed-secret");
    expect(redacted).not.toContain("proxy-prefixed-secret");
    expect(redacted).not.toContain("session-prefixed-secret");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("clean text stays");
    expect(redacted).toContain("the api key was rotated");
  });

  it("redacts quoted and JSON-shaped secret values", () => {
    const redacted = redactSubagentTranscriptSecrets(
      [
        '{"api_key": "sk-live-0123456789abcdef"}',
        '"Authorization": "Basic dXNlcjpwYXNzMTIz=="',
        '"Cookie": "session=abc123; theme=dark"',
        '"x-api-key": "very-secret-key-value-987"',
        'oauth_token: "ya29.a0AfH6SMBx123456"',
      ].join("\n"),
    );

    expect(redacted).not.toContain("sk-live-0123456789abcdef");
    expect(redacted).not.toContain("dXNlcjpwYXNzMTIz");
    expect(redacted).not.toContain("session=abc123");
    expect(redacted).not.toContain("very-secret-key-value-987");
    expect(redacted).not.toContain("ya29.a0AfH6SMBx123456");
  });

  it("redacts bare bearer credentials outside a header", () => {
    const redacted = redactSubagentTranscriptSecrets(
      "the request used bearer SKWA1zYx9Qm2Lp7Vb3Nc8Rd5Tf6Gh4Jk and failed",
    );
    expect(redacted).not.toContain("SKWA1zYx9Qm2Lp7Vb3Nc8Rd5Tf6Gh4Jk");
    expect(redacted).toContain("[REDACTED]");
  });

  it("is idempotent", () => {
    const observed = "Authorization: Bearer abcdefghijklmnopqrstuv token one";
    const once = redactSubagentTranscriptSecrets(observed);
    expect(redactSubagentTranscriptSecrets(once)).toBe(once);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(countCodePoints("😀😀")).toBe(2);
  });

  it("redacts before truncating so a cut field never leaks a secret tail", () => {
    const secret = "Authorization: Bearer abcdefghijklmnopqrstuv";
    const filler = ` ${"x".repeat(4_100)} `;
    const sanitized = sanitizeSubagentTranscriptField(`${secret}${filler}`, 4_096);
    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).not.toContain("abcdefghijklmnopqrstuv");
    expect(sanitized.text).toContain("[REDACTED]");
    expect(countCodePoints(sanitized.text)).toBeLessThanOrEqual(4_096);

    const kept = sanitizeSubagentTranscriptField("short and clean", 4_096);
    expect(kept).toEqual({ text: "short and clean", truncated: false });
  });
});
