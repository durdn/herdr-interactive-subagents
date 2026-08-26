---
description: Stop a subagent this session spawned and close its tab
argument-hint: <handle> | --all
allowed-tools: Bash
---

Stop the subagent named in `$ARGUMENTS`, or every one this session spawned when given `--all`:

```bash
node "<plugin>/scripts/hs.mjs" stop <handle>
node "<plugin>/scripts/hs.mjs" stop-all
```

This closes the Herdr tab and drops the child from this session's registry. The Claude session
itself survives and can be brought back with `hs.mjs resume <handle>` as long as the registry
entry exists, so prefer stopping a child over leaving an idle tab open.

Never close a tab this session did not create; the script already refuses to.
