---
description: Spawn a Claude Code subagent in a background Herdr tab and give it a task
argument-hint: <role> <task...>
allowed-tools: Bash, SendMessage, Read
---

Delegate `$ARGUMENTS` to a subagent running in its own background Herdr tab.

The first word is the role (`scout`, `researcher`, `worker`, `reviewer`, or any role
`hs.mjs roles` lists). The rest is the task.

Follow the `herdr-subagents` skill. In short:

1. Spawn it, with `--cwd` set to the directory the task is about (a trusted one) and
   `--add-dir` for anything outside it:

   ```bash
   node "<plugin>/scripts/hs.mjs" spawn --role <role> --cwd "<dir>"
   ```

2. Send the task to the returned handle with `SendMessage`, `notify_when_idle: true`. Restate
   everything the child needs — it inherits none of this conversation.
3. Tell the user what you dispatched and which tab it is in. Do not poll for the result; it
   arrives on its own.

If no role is given, pick the one that fits the task and say which you chose.
