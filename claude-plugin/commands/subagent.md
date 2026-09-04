---
description: Spawn a Claude Code subagent in a background Herdr tab and give it a task
argument-hint: <role> <task...>
allowed-tools: Bash, SendMessage, Read
---

Delegate `$ARGUMENTS` to a subagent running in its own background Herdr tab.

The first word is the role (`general`, `scout`, `researcher`, `worker`, `reviewer`, or any role defined in
`.claude/agents/`). The rest is the task. If no role is given, pick the one that fits and say
which you chose.

Launch it in a single call. No `doctor`, no `roles`, no hunting for the script — that path below
is correct as written, on any machine:

```bash
node ~/.claude/herdr-subagents/hs.mjs spawn --role <role> --cwd "<dir the task is about>" \
  --task "<the task, restated in full>"
```

- `--cwd` must be a directory Claude Code already trusts; add `--add-dir <path>` for anything
  outside it, once per directory.
- Restate the task in full, including whatever it depends on from this conversation — the child
  inherits none of it — and say what shape you want the answer in.
- Then tell the user what you dispatched and which tab it landed in. Do not poll; the result
  arrives on its own as a message.

The `herdr-subagents` skill covers steering, blocked children, recovering a lost result, and
cleanup.
