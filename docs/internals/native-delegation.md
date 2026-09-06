# Native cross-provider delegation

The authenticated T3 MCP endpoint exposes `subagent_capabilities`,
`subagent_spawn`, `subagent_result` and `subagent_cancel`. A parent can select a
configured Codex, Claude or Pi instance for one child turn. Each child runs
through that instance's existing native adapter. Codex and Claude delegation
do not install, launch or depend on Pi.

`ChildRunService` resolves the parent from its MCP invocation credential and
checks the live adapter session. It resolves the child through
`ProviderAdapterRegistry`. It never accepts a parent ID, working directory,
executable, environment override or permission mode from tool arguments.
Children inherit the parent's working directory. They receive only the supplied
prompt; conversation history is not copied.

The initial implementation requires a full-access parent with a working
directory. Runtime modes do not imply equivalent restrictions across providers
(notably Pi has no Codex-style sandbox), so restricted parents receive an
explicit unsupported response. Interactive approval and user-input requests
end the child with an actionable failure; they are not silently approved.

Children use fresh `child-<uuid>` adapter session IDs. They are not registered
as orchestration threads or in `ProviderSessionDirectory`. Runtime ingestion
ignores events with no thread shell, preventing children from updating the
parent's conversation, session binding or checkpoint state. This also means
these runs do not yet populate the Agents surface. Their tools and results
remain visible in the parent's ordinary MCP activity.

No T3 MCP credential is issued to child sessions, so this interface cannot be
used recursively. Native provider tools and user-installed extensions remain
subject to their provider's configuration. The browser-access setting controls
the `preview` credential capability independently of `delegation`.

The service allows four active children per parent thread and sixteen per
environment. It retains up to 256 runs for the lifetime of the server, evicting
the oldest terminal run when full. Assistant output is bounded to 100,000
characters with an explicit truncation flag. Terminal results are published
after native session cleanup. Cancellation is a request; callers collect the
result to confirm cleanup has finished. A wait is capped at thirty seconds
and does not cancel the child when the MCP request ends.

Results are not durable across server restarts. There is no automatic parent
continuation when a child finishes, no steering or follow-up turns, and no
checkpoint or worktree creation for child edits. Parents must use
`subagent_result` while their originating session remains active. These limits
are part of capability discovery and tool descriptions.

Focused tests exercise both Codex/Claude directions, Pi participation, immediate
completion, cancellation, session isolation, restricted-parent rejection and a
full MCP toolkit invocation using native-adapter test doubles. Live provider
processes and client rendering require separate integration verification.
