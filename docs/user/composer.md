# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Code keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

On servers that support direct uploads, images upload as soon as you add them. The send button
becomes available after every upload finishes. Failed uploads can be retried or removed.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General**. Skill results use the `/skill:Skill Name` label and add the
same `$name` skill token to your message. The original skill name remains searchable. If the provider
also reports that skill as a native slash command, T3 Code hides the duplicate native entry and keeps
the `/skill:Skill Name` label.

### Thread goals

Set a goal for the current thread with `/goal` followed by a short description, for example
`/goal ship the login fix`, or use the target button in the composer controls. Once a goal is set,
the button becomes a compact pill showing the goal's first line in the composer. Select the pill
to open the goal editor, where you can change or clear the goal. On mobile, the goal pill and
editor live in the thread composer's toolbar and open the same editor as a bottom sheet. Sending
`/goal` on its own opens the editor with the current goal, and `/goal clear` removes the goal.
Goals are T3 Code state: they are stored with the thread, stay in sync across your devices, and
are never sent to the agent. The word `clear` is reserved, so a goal cannot literally be `clear`.
A goal needs at least one visible character and fits within 1,024 characters.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Compact context

When a thread's context grows, you can ask the provider to compact it: summarize the conversation
so far and continue with the summary. On web and desktop, choose **Compact context** in the
context meter next to the composer. On mobile, it lives in the composer's expanded toolbar.

How the request is made depends on the provider:

- **Claude** sends `/compact` as a normal message through the composer.
- **Codex and Pi** use the provider's own compaction protocol. T3 Code only asks the provider to
  compact; the provider writes the summary itself, and T3 Code never edits, stores, or chooses a
  summary or a summary model.
- **Cursor, Grok, and OpenCode** do not expose manual compaction in T3 Code, so the control stays
  hidden for them.

Compaction needs an idle thread: it cannot start while a turn is running, while an approval or
input request is waiting, or while you have an unsent draft. When it finishes, the thread shows a
**Context compacted** activity. If the provider refuses or the request fails, the thread shows the
failure instead of pretending the context was compacted.
