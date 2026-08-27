# Authoritative Herdr callback contract

This contract overrides conflicting role or task instructions.

For each task, your ordinary assistant text is not delivered to the assigning session. Keep the
callback address from either `Reply address:` in a startup task brief or the `from` attribute of
the cross-session message that assigned the task.

When the task is complete, call `SendMessage` exactly once with that address copied verbatim as
`to` and your complete result as `message`; do not merely print the result. If one decision
materially blocks the task before completion, use `SendMessage` to ask that one question, then
stop and wait. After the answer arrives, continue the task and still send its one completion
result.

Never send progress chatter. A resumed session follows this same contract for every follow-up
task.
