# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or
include a skill when the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer
so you can shorten them or split them into several messages.

## Attach files

Attach up to eight files per message. Images can be up to 10 MB; other files can
be up to 50 MB, subject to the environment's upload support and limit. The agent
receives them on the environment's machine.

Uploads begin when you add an attachment. All uploads must finish before the
message can send. Retry or remove a failed upload. On web and desktop, reloading
before an upload finishes requires you to attach that file again.

You can drag or paste images into the web or desktop composer. HEIC and HEIF
photos are converted to JPEG there and when selected from the iOS photo library;
the image limit applies after conversion. On mobile, you can also send files to
T3 Code through another app's system share sheet.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue
messages while disconnected. Uploads resume when you reconnect. Drafts and queued
messages survive app restarts. Signing out of T3 Connect keeps that work on your
device until you sign back into the same account.

## Custom models

On web and desktop, use Settings → Providers → **Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity
uses its account catalog and does not support custom models.

## Model defaults

T3 Code remembers your provider, model, and model options for new threads. A
project's configured model takes precedence; resetting that project setting
returns to the remembered selection.

In Settings → Providers, each provider instance can also have its own default model and options
(such as effort). New threads on that provider start from its configured default when nothing more
specific — an explicit choice, a project default — already picked one. Clear the default from the
same place to fall back to T3 Code's built-in default.

Model options shown as provider defaults remain display values until you choose them in T3 Code.
T3 Code only sends options you selected explicitly, so leaving reasoning level or service tier
unset uses the provider's own configuration.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose
**Cite in composer**. You can add a comment about the quote and write instructions
around it.

Select the quote in a draft or sent message to return to its source. If the source
is unavailable or has changed, the saved quote remains readable.

Mobile displays saved quotes and comments, but does not create citations or
navigate to their sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread. Press
`ArrowUp` again to go further back, and `ArrowDown` to come forward. Moving forward past the newest
prompt clears the composer. Recall walks the prompts loaded in the thread. Attachments, terminal
context, and other extras from the original message are not restored, only the text you typed. A
composer that holds an attachment or a picked element does not count as empty.

When the composer has text, the arrow keys move the caret as usual. Recall takes over only while
the text is an unedited recalled prompt, with the caret on the first visual line for `ArrowUp` or
the last visual line for `ArrowDown`, counting wrapped lines. Editing a recalled prompt turns it
into a normal draft.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save
the current prompt and its attachments for later. Wait for uploads to finish first.
With an empty composer, the same shortcut restores a single stash or opens the
stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment.
Those files are retained for 24 hours. After an upload expires, restore the prompt
and use **Attach again** or remove the missing file before sending.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record,
then confirm to transcribe. Text is inserted where your selection was when
recording started, ready for you to review and edit before sending.

The first use may download Apple's speech model and needs a network connection.
Later transcription works offline for that language. Recordings can be up to five
minutes long. Canceling, leaving the screen, or an audio interruption discards the
recording and preserves your existing draft.

Transcription runs on your device. T3 Code deletes the temporary audio after
transcription or cancellation; only the message text is sent when you submit.

## Agent voice notifications

The composer footer has a **Voice on / Voice off** control next to the access mode. It sets whether
the coding agent T3 Code starts for that thread announces itself out loud — T3 Code passes the
choice to the agent as the `T3_VOICE_NOTIFICATIONS` environment variable (`1` or `0`), and the
agent's own notification hooks decide what to say; T3 Code itself stays silent. New threads start
with voice on. The setting is per thread and takes effect the next time the thread starts an agent
session.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. T3 Code opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and
provider. On mobile, both are also available before starting a thread on
**New task**.

The slash menu also includes skills unless you turn off **Settings → General →
Show skills in slash menu**. Only skills enabled for the provider are listed.

Provider commands must start the message to run. T3 Code commands such as
`/model` and `/plan`, and skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the
provider supports it. Web and desktop also offer compaction from the context meter.

## Images and videos in messages

Select an image or video attachment or link to preview it. Playback support depends
on your browser or device; save an unsupported video to open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile,
touch and hold an image or video thumbnail and choose **Save or share**. On iOS,
return to the thumbnail to open this menu after watching a full-screen video.

File links refer to the environment's machine, including when you connect remotely.
Previews use the original file, even outside the workspace. Moving or deleting it
can break the preview, so save a copy if you need to keep it.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace.
These files open read-only. An HTML file outside the workspace cannot load scripts,
styles, or images from neighboring files.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML
file to source view to read its markup; a link to a specific line opens source
automatically. HTML previews cannot access your T3 Code session.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer;
Android opens the system chooser.

## Thread goals

Set a goal for the current thread with `/goal` followed by a short description, for example
`/goal ship the login fix`, or use the target button in the composer controls. Picking `/goal`
from the slash menu switches the input into goal mode directly, the same as selecting the target
button. Once a goal is set, the goal appears in a compact strip above the composer, and the button
becomes a compact pill showing the goal's first line. Select the pill to switch the chat input into
goal mode: the input changes colour, and sending writes the goal instead of a message. Select the
pill again to go back. On mobile, the goal pill lives in the thread composer's toolbar and opens a
goal editor as a bottom sheet. Sending `/goal` on its own
fills in the current goal for editing, and `/goal clear` removes it. The `mod+shift+g` shortcut
toggles goal mode without leaving the keyboard. Pressing Esc while typing in goal mode leaves goal
mode and keeps whatever you typed.
Goals are T3 Code state: they are stored with the thread and stay in sync across your devices.
The word `clear` is reserved, so a goal cannot literally be `clear`. A goal needs at least one
visible character and fits within 1,024 characters. This is separate from a Codex execution
goal, which Codex itself tracks in a live session — see
[Codex](./providers-codex.md#codex-execution-goals).

#### Goal loop

On servers that support it, setting a goal also starts a goal loop: T3 Code adds the goal to each
turn it sends the agent and keeps starting follow-up turns until the agent reports the goal done,
says it is stuck, or you step in. On a Codex thread the goal instead becomes Codex's own execution
goal, and Codex drives the follow-up work — see
[Codex](./providers-codex.md#thread-goals-map-onto-the-execution-goal).

The loop only changes between turns, never in the middle of one. Every control below therefore
takes effect once the turn that is running ends. The goal pill shows the loop's state:

- A running loop shows an iteration count, such as `3/10`.
- **Paused** holds the loop without losing progress; select the pause button on the pill, or pause
  it from the thread's menu. The running turn finishes, and no new turn starts after it. Resume
  clears the hold.
- **Blocked** means the agent reported it cannot continue; the pill's tooltip shows why. Resume
  clears the block.
- **Capped** means the loop reached its 10-turn ceiling. Select **Continue anyway** on the pill to
  set the count back to zero.
- **Complete** means the agent reported the goal done.

A newly set goal starts its first turn on its own when the thread is idle. If a turn is already
running, the goal starts as soon as that turn ends. A resume or a **Continue anyway** also starts
the next turn on its own — you do not have to send a message — and the agent picks up from where the
loop stopped rather than re-reading the reply that paused or blocked it. Clearing the goal with
`/goal clear`, or the pill, stops the loop along with it.

You can send a `/goal` command while a turn is running — setting, editing, and clearing a goal are
thread state, not messages to the agent, so the composer sends them instead of queueing them.

#### Goal experiments

Goal experiments let an agent try measured changes inside a fixed set of files. Add
`.auto/config.json` to a clean repository on a dedicated, unprotected branch:

```json
{
  "version": 1,
  "branch": "experiment/faster-startup",
  "files": ["src/startup.ts"],
  "evaluator": {
    "argv": ["node", "scripts/measure-startup.mjs"],
    "metric": "milliseconds",
    "direction": "lower",
    "minimumImprovement": 5
  },
  "checks": [["vp", "test", "run", "src/startup.test.ts"]],
  "limits": {
    "maxExperiments": 8,
    "maxApplyBytes": 262144,
    "maxOutputBytes": 65536,
    "evaluatorTimeoutSeconds": 60,
    "checkTimeoutSeconds": 120,
    "maxTotalSeconds": 900
  },
  "protectedBranches": ["main"]
}
```

Run `/goal experiment <objective>` on an existing connected thread without attachments. T3 Code
shows the exact branch, HEAD, approved files, commands, metric, provider support, digest, and limits
it read from the server. Nothing starts until you select **Confirm and start**. A changed or expired
preview is rejected, so review a fresh preview instead of approving stale settings.

Experiments fail closed on providers that cannot enforce the restricted experiment tool set. A run
measures its baseline first, then keeps only candidates that improve the configured metric by at
least `minimumImprovement` and pass every check. Rejected candidates are restored. The goal control
shows the phase, baseline and best values, experiment count, elapsed time, and last error. You can
pause or clear an active run. Reaching `maxExperiments` or `maxTotalSeconds`, failing, or completing
is terminal; resume and **Continue anyway** cannot reset those limits.

## Subscription usage limits

Providers that bill against a subscription report how much of each usage window you have spent.
Open the context meter next to the composer to see them under **Usage limits**: one row per
window, with the share used and when it resets.

- **Claude** reports its 5-hour window, its weekly window, and the per-model weekly windows.
- **Codex** reports its two rolling windows.
- **GLM (through Pi)** reports its 5-hour window when a z.ai key is configured.

The rows come from the provider itself, so a window only appears once that provider has reported
it in the open thread. Providers without subscription limits show nothing.

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
