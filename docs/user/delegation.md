# Delegate across providers

An agent can delegate a task to a different configured provider. For example,
a Codex conversation can ask a Claude child to investigate a question, and a
Claude conversation can ask a Codex child to review code. Each child uses its
own provider directly. Pi is needed only when choosing a Pi child.

Ask your agent to check its delegation capabilities, then specify the provider
and model you want. The parent must currently have full access. Children share
its working directory and receive the task prompt without the conversation
history. Give each child a clear task and avoid overlapping file edits.

The parent can check results, wait for completion or cancel a child. Up to four
children can run at once for a conversation. Results appear through the
parent's tool activity; these runs do not yet appear in the Agents view.
Tasks that need interactive input fail with an explanation.

Keep the parent session and server running until results are collected.
Children do not automatically wake the parent, and results are lost when the
server restarts. The server retains up to 256 child results, with older finished
results removed as new children start. Long output is truncated explicitly.
Delegation works independently of agent browser access.
