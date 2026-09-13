# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Reduce context usage

Choose **Compact context** in the context meter (web and desktop) or in the composer's expanded
toolbar (mobile) to ask Codex to summarize the conversation and continue with the summary. T3 Code
sends Codex's own compaction request — Codex writes the summary, and T3 Code never edits it or
picks a summary model. Compaction only runs on an idle thread; while a turn is running the control
waits. The thread's **Context compacted** activity appears when Codex finishes.

## Use multiple accounts

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

To limit native multi-agent fan-out, set **Maximum concurrent subagents** in the provider settings.
The value counts child subagents and excludes the primary session. It applies to new sessions; leave
it blank to use Codex's default.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.

## Sub-agent models

The web and desktop Agents panel shows each sub-agent's model and reasoning effort when Codex
reports them. If Codex does not report either value, T3 Code leaves it out instead of using the
parent agent's settings.

## Codex execution goals

Codex can track an **execution goal** for a thread on its own: an objective it works toward with a
token budget, time used, and a status it updates itself. T3 Code does not create or store these
goals — it reads the one Codex already set for the live session.

Open **Codex execution goal…** from the thread's action menu (click the thread title in the chat
header, or right-click the thread in the sidebar). On mobile, use the flag button in the composer's
expanded toolbar. The panel shows the objective, status, tokens used, time used, and when Codex
last updated it. **Refresh** re-reads the live goal.

You can also act on it:

- **Pause** asks Codex to pause an active goal for this session.
- **Clear** asks Codex to stop tracking the goal. Clearing asks for confirmation first.

Reading and changing the execution goal needs a live Codex session for the thread. If Codex is too
old to know execution goals, the panel says so — update the Codex CLI and try again.

### Thread goals map onto the execution goal

On a Codex thread, the [thread goal](./composer.md#thread-goals) you set in T3 Code becomes Codex's
execution goal with the same text, and clearing the thread goal clears Codex's. Codex then drives
its own follow-up work; T3 Code never starts continuation turns on a Codex thread.

Pausing the thread goal pauses the Codex goal, and resuming it sets the goal back to active. T3
Code follows Codex's status rather than overriding it: while Codex is working, the goal reads as
running; if Codex pauses the goal itself, T3 Code shows it paused and leaves it there for you to
resume. If Codex clears the goal on its own, the thread goal is marked blocked so you can see what
happened.

Clearing a thread goal always works, even when Codex refuses the request or the session is gone.
The T3 Code side is cleared either way, and the failure shows up in the thread's activity so the
two are never quietly out of step.
