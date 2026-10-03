/**
 * Full RTK provider guidance, bundled verbatim from pinned upstream sources so
 * a ready session gets RTK's complete awareness without `rtk init`, provider
 * config writes, or runtime network access. These constants are pure text;
 * adapters decide when to inject them (CodexDeveloperInstructions.ts and
 * ClaudeAdapter.ts).
 *
 * Source: rtk-ai/rtk v0.49.0, commit b1c0dc00649c50fbe8930f849c800d4d6ca12091,
 * Apache-2.0 — https://github.com/rtk-ai/rtk/blob/v0.49.0/LICENSE
 * - RTK_CODEX_SESSION_INSTRUCTIONS: hooks/rtk-awareness-full.md
 *   (sha256 278274ef3d08c858d4247cc91419c4d74ef922b95719e987b22e896aef10e1fc; the exact content `rtk init -g --codex` writes to RTK.md)
 * - RTK_CLAUDE_SESSION_INSTRUCTIONS: the RTK_INSTRUCTIONS block in
 *   src/hooks/init.rs (sha256 1150dc9b591a15868f085060b27c93750914581b6b5c8d1beac60bdc4fef498f; the legacy `rtk init --claude-md` block)
 *
 * Updating this text is a deliberate source refresh: re-copy from a new pinned
 * tag and update the provenance and hashes above.
 *
 * Flagged inapplicable content, preserved verbatim per upstream policy: the
 * Claude text's "Meta Commands" section documents `rtk init` and
 * `rtk init --global`, which write CLAUDE.md files. T3 never runs them, and a
 * T3 session following this text should not either — the project toggle
 * attaches guidance, not consent to edit provider config files.
 */

/**
 * T3-owned preamble delivered with the pinned guidance above; this is not
 * upstream text. The pinned Claude block's "Meta Commands" section advertises
 * `rtk init`, so this preface states the session-only contract the provider
 * actually runs under.
 */
export const RTK_SESSION_PREFACE =
  "Note from T3 Code: RTK is already configured for this session, and this guidance applies to this session only. Do not run `rtk init`, install RTK hooks, or edit AGENTS.md, CLAUDE.md, or any other provider configuration file on account of this guidance.";

export const RTK_CODEX_SESSION_INSTRUCTIONS = `# RTK

Prefix every shell command with \`rtk\`: \`rtk git status\`, \`rtk cargo test\`,
\`rtk npm run build\`, \`rtk ls src/\`. Keep the prefix inside chains:
\`rtk git add . && rtk git commit -m "msg"\`. Commands RTK has no filter for
run as-is, so the prefix is always safe.

# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as \`rtk proxy <cmd>\` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.

## About RTK

RTK (Rust Token Killer) is a CLI proxy that filters command output to save
tokens; behavior and exit code are unchanged.

- \`rtk gain\` / \`rtk gain --history\` — token savings, overall and per command.
- \`rtk proxy <cmd>\` — run a command unfiltered, still tracked.
- \`RTK_DISABLED=1 <cmd>\` — skip RTK for one command.
- \`rtk discover\` — find past commands RTK could have condensed.
`;

export const RTK_CLAUDE_SESSION_INSTRUCTIONS = `<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with \`rtk\`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with \`&&\`, use \`rtk\`:
\`\`\`bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
\`\`\`

## RTK Commands by Workflow

### Build & Compile (80-90% savings)
\`\`\`bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
\`\`\`

### Test (60-99% savings)
\`\`\`bash
rtk cargo test          # Cargo test failures only (90%)
rtk go test             # Go test failures only (90%)
rtk jest                # Jest failures only (99.5%)
rtk vitest              # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk pytest              # Python test failures only (90%)
rtk rake test           # Ruby test failures only (90%)
rtk rspec               # RSpec test failures only (60%)
rtk test <cmd>          # Generic test wrapper - failures only
\`\`\`

### Git (59-80% savings)
\`\`\`bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
\`\`\`

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)
\`\`\`bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
\`\`\`

### JavaScript/TypeScript Tooling (70-90% savings)
\`\`\`bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
rtk uv run <cmd>        # Compact uv project command output
\`\`\`

### Files & Search (60-75% savings)
\`\`\`bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%). Format flags (-c, -l, -L, -o, -Z) run raw.
rtk find <pattern>      # Find grouped by directory (70%)
\`\`\`

### Analysis & Debug (70-90% savings)
\`\`\`bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
\`\`\`

### Infrastructure (85% savings)
\`\`\`bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
\`\`\`

### Network (65-70% savings)
\`\`\`bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
\`\`\`

### Meta Commands
\`\`\`bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
\`\`\`

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->
`;
