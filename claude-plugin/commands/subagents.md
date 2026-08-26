---
description: Show the subagents this session spawned and what they are doing
allowed-tools: Bash
---

List the children this session owns and their live Herdr state:

```bash
node ~/.claude/herdr-subagents/hs.mjs list
```

Report each one's handle, role, status, and tab. For anything showing `blocked`, inspect it
before saying anything about it:

```bash
herdr agent read <handle> --source detection --lines 40
```

and tell the user what it is waiting on. Do not answer a blocked child's dialog yourself.

`stopped` means you closed its tab; the Claude session survives and `hs.mjs resume <handle>`
brings it back with its history. `gone` means the tab vanished some other way - the session
is usually still resumable too.
