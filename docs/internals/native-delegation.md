# Native cross-provider delegation

The authenticated T3 MCP endpoint exposes `subagent_capabilities`,
`subagent_spawn`, `subagent_send`, `subagent_result` and `subagent_cancel`.
Codex, Claude and Pi parents can select any configured native Codex, Claude or
Pi child instance. Each child runs through that provider's existing adapter;
Codex and Claude delegation does not install, launch or depend on Pi.

`ChildRunService` derives parent identity from the session-bound MCP credential
and checks the live adapter session. Tool arguments cannot choose a parent,
working directory, executable, environment or permission mode. Children share
the parent's working directory and runtime mode but receive only the supplied
prompt. No MCP credential is installed in a child, so delegation is not
recursive by default.

Codex and Claude enforce restricted child modes. Pi children require full
access because Pi has no equivalent non-interactive sandbox; capability
discovery reports that target as unavailable instead of escalating it.
Interactive requests fail the child explicitly and are never approved by T3.

Children use private `child-<uuid>` adapter session IDs and never enter
`ProviderSessionDirectory`. `ChildRunService` observes the canonical
`ProviderService` event broadcast, so it cannot compete with an adapter queue
consumer. It emits `t3-native` task activities into the normal orchestration
pipeline. The existing snapshot and activity folds display those runs in the
web and desktop Agents inventory and the mobile work log without allowing child
events to alter the parent's session or checkpoint state. The existing Agents
control router sends steer and cancel actions back to the same T3-owned child
service; terminal follow-ups remain available to the parent agent.

Native resume identity, bounded output and delivery state live in SQLite.
Assistant output is capped at 100,000 characters with an explicit truncation
flag. A restart reconciles nonterminal rows to an interrupted failure; terminal
results remain collectible by a renewed credential for the same parent thread.
The service allows four active children per parent and sixteen per environment.

After native session cleanup, completion is delivered through a normal
`thread.turn.start` command. The decider atomically accepts this internal
command only when the parent has no live session, blocking request or queued
start. Deterministic run-and-attempt command IDs make retries idempotent.
Reading a result is side-effect free and does not suppress automatic delivery.
Stopping the parent cancels its active children and marks their result handled,
so an explicit stop cannot restart the conversation.

`subagent_send` sends a native steer while the child is active. For a terminal
child it creates a linked follow-up run from the stored provider resume cursor.
Child edits do not create independent T3 checkpoints or worktrees.

Pi has no built-in MCP client. T3 materializes a small Pi extension in the
server cache and injects the session's MCP endpoint and bearer credential. The
extension completes the MCP handshake, discovers tools and forwards calls
through Pi's public tool API. It is a transport adapter only; Pi never becomes
the shared engine for Codex or Claude children.
