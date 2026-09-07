# Delegate across providers

Codex, Claude and Pi conversations can delegate work to any configured Codex,
Claude or Pi provider. Each child uses that provider directly. Pi is never used
as an engine for Codex or Claude work.

Ask the parent agent to check its delegation capabilities, then name the
provider and model you want. Children share the parent's working directory and
receive the task prompt without the conversation history. Codex and Claude
children can inherit restricted modes. Pi children currently require full
access. Give each child a clear task and avoid overlapping file edits.

The parent can inspect a result, wait, cancel, steer a running child, or start a
follow-up from a finished child. Up to four children can run at once for a
conversation. Their status appears in the Agents view on web, desktop and
in the mobile work log. Active runs can be steered or cancelled from the Agents
view. Tasks that need interactive input fail with an explanation.

When a child finishes, T3 delivers its result after the parent becomes idle.
Finished results survive server and parent-session restarts. Work interrupted
by a server restart is reported as failed rather than left running. Explicitly
stopping the parent cancels its active children without restarting the
conversation. Long output is truncated explicitly. Delegation is independent
of agent browser access.

Delivery appears as a subagent result card in the conversation rather than as
something you typed yourself, even though the agent receives it as a normal
turn.
