# Optimizers

T3 Code can connect already-installed optimizer tools to provider sessions. Open **Settings →
Optimizers** on web or desktop, choose the environment that runs the provider, and inspect the
host-local status. Optimizers are off for every project until you enable them. Use the command
palette's **Project optimizers** submenu for a quick per-project toggle.

The mobile app shows the same environment status, savings counters, and Codebase Memory index
health. Mobile is an observer: configure project attachments from web or desktop.

## RTK

[Install RTK](https://github.com/rtk-ai/rtk) on the environment that runs your provider. RTK is a
CLI wrapper that filters shell output. T3 attaches its supported provider integration when RTK is
enabled for a project. v1 supports Claude Code through its hook surface and Codex through
instructions; other providers show as unsupported.

RTK's gain counter comes from its environment-wide history database. The **Savings** panel labels
it as environment-level, so it is not a per-project total.

## Headroom

[Get Headroom](https://extraheadroom.com) on the provider environment. T3 detects Headroom's
local proxy and reports the running state and savings when its client configuration routes through
that proxy. The project toggle records whether T3 should use the integration for the next session;
it never starts, stops, or edits Headroom.

Headroom support in v1 is limited to Claude Code and Codex sessions routed through Headroom. Its
savings are environment-level counters.

## Codebase Memory

[Install Codebase Memory](https://github.com/DeusData/codebase-memory-mcp) on the provider
environment. T3 starts it as a project-scoped stdio MCP server for supported providers and keeps
the index rooted at that project. Claude Code, Codex, Grok, Cursor, and Antigravity are supported
in v1; OpenCode and Pi are not.

The **CBM index health** section shows indexing, ready, or degraded state and node/edge counts.
CBM does not report token savings, and T3 does not delete its index data. Use CBM's own tooling if
you need to manage an index.

When a provider session starts, T3 reports which configured optimizers were attached and which had
positive readiness evidence. A configured optimizer can still be unavailable on a provider or
host, so “enabled” does not mean “attached.”
