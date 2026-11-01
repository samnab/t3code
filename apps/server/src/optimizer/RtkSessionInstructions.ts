// RTK's Codex guidance, copied verbatim (no `rtk init`, config writes, or network) from
// rtk-ai/rtk v0.49.0 b1c0dc00649c50fbe8930f849c800d4d6ca12091 hooks/rtk-awareness-full.md
// (Apache-2.0, sha256 278274ef3d08c858d4247cc91419c4d74ef922b95719e987b22e896aef10e1fc).
// Refresh deliberately from a new pinned tag and update this provenance.

// T3-owned preface: session-only contract, and narrows upstream's "prefix every command"
// rule, since `rtk <unsupported>` runs unfiltered and pushed agents to `rtk proxy`.
export const RTK_SESSION_PREFACE =
  "Note from T3 Code: RTK is already configured for this session, and this guidance applies to this session only. Do not run `rtk init`, install RTK hooks, or edit AGENTS.md, CLAUDE.md, or any other provider configuration file on account of this guidance. Prefix only commands RTK supports: read files with `rtk read <file>`, never `rtk cat`, and run commands such as `python3`, `sed`, `node`, `date`, and `ssh` without the `rtk` prefix. Never reach for `rtk proxy` first; use it only to re-run one command whose filtered output was unusable.";

// oxlint-disable-next-line t3code/no-em-dash-copy -- verbatim pinned upstream text; edits break the provenance hash
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
