# Glossary

> For maintainers. Using T3 Code? See [docs/user](../user/).

This is a living glossary for T3 Code. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)
- [Appearance](#appearance)

## Concepts

### Project and workspace

#### Environment

One running server and the machine, credentials, workspace access, and state it owns.

#### Client

A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server.

#### T3 home

The base data directory. Runtime state normally lives under its `userdata` directory.

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

#### Goal

A short, durable, T3-owned statement of intent for a thread, set with `/goal` or the composer's goal pill and editor. It rides thread metadata (see the `goal` field in [the contracts][1]). On a server and thread with a [goal loop](#goal-loop), T3 sends it to the agent as continuation turns run; otherwise it never enters provider prompts or chat history and is purely user-facing state.

#### Goal loop

The drive state layered on a [Goal](#goal) that turns it from inert text into continuation turns: `ThreadGoalLoop` (state, mode, iterations, maxIterations, reason) in [the contracts][1]. State moves through `idle` → `running` (T3 or the provider is working the goal) → `paused` (user hold) / `blocked` (agent reported it cannot proceed) / `capped` (iteration ceiling, default 10) / `completed` (agent's own done signal). Mode is derived from the thread's provider, never chosen by the user: `t3` injects the goal into each provider turn and starts continuation turns from `GoalLoopReactor`, `native` binds the goal to the provider's own goal instead of driving turns — `NativeGoalReactor` sets and clears Codex's [execution goal](#execution-goal-codex-native) from the T3 goal, mirrors Codex's status back onto `state` through the server-only `sync` action, and re-derives `mode` from the bound session's real driver because the decider can only guess it from the instance id — and `unsupported` is reserved for a provider that can do neither and is not produced today. The `thread.goal.loop` command (pause/resume/continue/complete/block/reset, plus the server-only `sync`) drives transitions; see [decider.ts][8]. Only `GoalLoopReactor` starts T3 turns, and only for a `t3`-mode thread: at a turn boundary (`thread.turn-diff-completed`), on the boot sweep, or on a `thread.goal-loop-updated` event whose `resumed` flag is set. The decider sets that flag for `resume` and `reset` alone, so those two start the next turn immediately while a freshly set goal waits for the user's first message, and a `sync` never starts one. A resumed turn skips the last-reply scan, because that reply still carries the `<goal_blocked>` or `<goal_complete>` tag that stopped the loop. On a `native` thread the same resumed event instead makes `NativeGoalReactor` push the goal back to Codex as active.

#### Execution goal (Codex-native)

A provider-owned objective that Codex itself tracks for a live session (objective, status, token budget, time used), read on demand through `thread/goal/*` on the live provider session. Unlike the T3-owned [Goal](#goal), it is never persisted, projected, or synced into thread state — T3 only reads it, sets it, pauses it, or clears it. `thread/goal/updated|cleared` notifications map to one status-only `thread.goal.updated` runtime event, which `NativeGoalReactor` mirrors onto the [goal loop](#goal-loop) — no objective history is ever projected.

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Command receipt

A durable record of a command's result, used to make retries idempotent.

#### Runtime receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Runtime receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Drivers ship built in for Codex, Claude, Cursor, Grok, Pi, OpenCode, and Antigravity. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Driver

The integration for a provider kind.

#### Provider instance

One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

#### Model manifest

The per-driver list of current model slugs that decides which models land in the model picker's legacy section. Bundled at `apps/server/src/provider/model-manifest.json` and refreshed at runtime from the same file on `main`, so classification updates ship as commits instead of releases. See the [provider architecture][16] model manifest section.

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

### Appearance

#### Environment theme

A theme an environment's machine publishes for clients to follow, one file per theme under `themes/` in that environment's state directory; the filename is the theme id. [environmentTheme.ts][25] watches the directory and streams the set over `subscribeServerConfig`; clients render each as a library card, generating a full palette when the file carries seed colors and using the palette directly when it is a standard exported theme file. A desktop that retints its apps when the system theme changes rewrites its file, so T3 Code follows along without a restart. See [environment-theme.md][26].

#### Default theme

The environment's theme, held in its `settings.json` as `defaultTheme` (with `defaultThemeSetAt`
as the set-generation) and set with `t3 theme set <id>`. Web and desktop clients apply each set
once — live when connected, on the next connect otherwise — so setting it switches them, while a
theme a user picks in Settings afterwards sticks until the next set; mobile keeps its own
appearance settings. Naming a published [environment theme](#environment-theme) is how a desktop
ships T3 Code already matching it.

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ../../apps/server/src/environmentTheme.ts
[26]: ../user/environment-theme.md
