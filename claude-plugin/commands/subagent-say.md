---
description: Send a message to a running subagent
argument-hint: <handle> <message...>
allowed-tools: Bash, SendMessage
---

Send the rest of `$ARGUMENTS` to the subagent named by the first word, with
`SendMessage({ to: "<handle>", message: "..." })`.

Rules:

- If the child is waiting on a question it asked, this is the answer — send it as-is.
- If the handle is ambiguous (`N agents are named ...`), re-send with the `[ref]` the error
  gives you; do not guess.
- If the handle is not live, check `hs.mjs list`. A `gone` child needs
  `hs.mjs resume <handle>` first.

Its reply arrives on its own. Do not wait on it in a tool call.
