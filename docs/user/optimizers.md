# Optimizers

T3 Code can connect already-installed optimizer tools to provider sessions. Open **Settings →
Optimizers** on web, desktop, or mobile, choose the environment and project that run the provider,
and inspect the host-local status. Optimizers are off for every project until you enable them. Use
the command palette's **Project optimizers** submenu for a quick per-project toggle on web and
desktop.

The mobile app shows the same environment status, environment-level savings counters, and Codebase
Memory index health. It also lets you choose a project and toggle its optimizer attachments.

## RTK

[Install RTK](https://github.com/rtk-ai/rtk) on the environment that runs your provider. RTK is a
CLI wrapper that filters shell output. T3 attaches its supported provider integration when RTK is
enabled for a project. v1 supports Claude Code through its hook surface and Codex through
instructions; other providers show as unsupported.

RTK's gain counter comes from its environment-wide history database. The **Savings** panel labels
it as environment-level, so it is not a per-project total.

## Headroom

[Get Headroom](https://extraheadroom.com) on the provider environment. T3 detects Headroom's local
proxy and reports its running state and savings. When Headroom is enabled for a project, T3 routes
supported new sessions through a healthy proxy using session-only launch settings. Turning it off
stops T3 from adding those settings to later sessions; existing provider routes remain unchanged.
T3 never starts, stops, or edits Headroom.

Headroom support in v1 covers first-party Claude Code and Codex sessions. T3 leaves cloud modes and
custom upstreams unchanged and preserves recognized provider configurations that already select
Headroom. Its savings are environment-level counters.

Set the proxy URL in the selected environment's **Settings → Optimizers → Configuration** section.
Enter the base HTTP loopback origin, without a `/v1` path. T3 defaults to
`http://127.0.0.1:6767`; if your opt-in shell alias starts Headroom on port 8787, use
`http://127.0.0.1:8787`. T3 uses this address to check the existing proxy and route supported
sessions for enabled projects. It does not start Headroom or change provider configuration files.

## Codebase Memory

[Install Codebase Memory](https://github.com/DeusData/codebase-memory-mcp) on the provider
environment. T3 starts it as a project-scoped stdio MCP server for supported providers and keeps
the index rooted at that project. Claude Code, Codex, Grok, Cursor, Antigravity, and managed
OpenCode are supported in v1; external OpenCode and Pi are not.

The **CBM index health** section shows indexing, ready, or degraded state and node/edge counts.
CBM does not report token savings, and T3 does not delete its index data. Use CBM's own tooling if
you need to manage an index.

When a provider session starts, T3 reports which configured optimizers were attached and which had
positive readiness evidence. The current thread indicator distinguishes attached tools from ready
backends; work-log entries are session records for history. A configured optimizer can still be
unavailable on a provider or host, so “enabled” does not mean “attached.”
