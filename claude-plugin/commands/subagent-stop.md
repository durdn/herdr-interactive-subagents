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

This closes the Herdr tab and drops the child from this session's registry. The Claude session
itself survives and `hs.mjs resume <handle>` brings it back as long as the registry entry
exists, so prefer stopping a child over leaving an idle tab open.

Never close a tab this session did not create; the script already refuses to.
