---
description: Stop a subagent this session spawned and close its tab
argument-hint: <handle> | --all
allowed-tools: Bash
---

Stop the subagent named in `$ARGUMENTS`, or every one this session spawned when given `--all`:

```bash
node ~/.claude/herdr-subagents/hs.mjs stop <handle>
node ~/.claude/herdr-subagents/hs.mjs stop-all
```

This closes the Herdr tab and marks the child stopped in this session's registry. The entry and
Claude session remain, so `hs.mjs resume <handle>` brings it back; `hs.mjs forget <handle>` is the
operation that permanently removes a stopped entry.

Never close a tab this session did not create; the script already refuses to.
