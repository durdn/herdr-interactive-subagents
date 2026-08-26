# Claude Code as the orchestrator

Supersedes the conclusion of [`skill-only-design.md`](skill-only-design.md), which asked whether a
skill could replace this pi extension and answered "only for synchronous delegation". That answer
was correct for pi and for Claude Code as it stood. It is no longer correct: Claude Code 2.1.246
ships the async primitives the document said a skill could not have.

This document records the target design and the spike that verified it.

## Why

pi cannot drive Claude Code on a Claude subscription, so on this machine the orchestrator has to
*be* Claude Code. The pi extension stays as-is; this is a parallel path with the same topology —
one child per background tab in the orchestrator's Herdr workspace.

## Division of labour

| Concern | Owner |
| --- | --- |
| Child process placement, visibility, attach/takeover, `working`/`blocked`/`done` | Herdr |
| Addressing, delivery, wake-on-message, permission class, session persistence | Claude Code |
| Role definitions, spawn contract, ownership registry, cleanup | this package |

Nothing here re-implements a watcher, a steer channel, or a name service. Those exist.

## Primitive mapping

| pi extension | Claude Code 2.1.246 |
| --- | --- |
| `subagent()` async spawn | `herdr tab create` + `herdr agent start --kind claude` |
| `pi.sendMessage(deliverAs: "steer")` | child → parent `SendMessage`; `notify_when_idle` for the completion notice |
| `subagent_message()` | native `SendMessage` by name |
| name registry | session `--name` *is* the address; `ListAgents`, `herdr agent list` |
| session resume | `claude --resume <uuid>`, uuid pinned by us with `--session-id` |
| `ask_question` | child `SendMessage`s the parent and goes idle; the parent's reply wakes it |
| loadout sandbox | role file + `--agent` / `--allowedTools` / `--permission-mode` |

## Spike results (2026-08-26, Windows 11, herdr 0.8.2-preview, claude 2.1.246)

Run by hand in workspace `wJ`. Every gate passed.

1. `herdr tab create --workspace wJ --cwd <repo> --label hs-spike --no-focus` → `wJ:t3M` /
   `wJ:p44`, no focus stolen.
2. `herdr agent start hs-spike --kind claude --pane wJ:p44 -- --name hs-spike --session-id <uuid>
   --model haiku --permission-mode acceptEdits` → `agent_status: idle`, `interactive_ready: true`,
   and Herdr's claude integration reported the session id straight back in
   `agent_session.value`.
3. The child appeared in the parent's `ListAgents` as `hs-spike` within seconds.
4. `SendMessage` parent → child delivered over the Windows named pipe and woke it; Herdr flipped
   the tab to `working`.
5. The child replied with `SendMessage`; it arrived as `<cross-session-message from-name="hs-spike"
   from-mode="prompting">`.
6. `--session-id` produced the transcript at exactly
   `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`; last-assistant extraction from it works.
7. Tab closed, new tab created, `herdr agent start ... -- --resume <uuid> --name hs-spike` →
   same session id, name reclaimed, full prior context intact.
8. `herdr tab close` left no orphan agent in `herdr agent list`.

### Findings that shape the design

- **A child reports back only when told to.** The second spike message asked it to "answer" and it
  answered — into its own transcript, where the orchestrator never sees it. The reply contract has
  to live in the role body, not in the per-task prompt.
- **Parent session names drift.** Claude Code renamed the orchestrator mid-session from `cfg-69`
  to a topic-derived name. Never bake a parent name into a child. The child replies to the
  `from` address carried on the incoming message.
- **Deliver the task by message, not as a CLI prompt.** A task passed as `claude "<task>"` arrives
  with no reply address. Spawn an idle, role-configured child and send the task with
  `SendMessage` — the address travels with it, and `notify_when_idle` can ride along.
- **New Herdr tabs run Windows PowerShell 5.1** (`$PSEdition = Desktop`). Prefer `--agent <role>`
  over long quoted `--append-system-prompt` arguments so nothing depends on shell quoting.
- **Permission class governs delivery.** `acceptEdits` children sit in the "prompting" class, so
  their messages to an `auto`/`acceptEdits` parent are delivered rather than held. A
  `bypassPermissions` child would have every message held for approval — a second reason not to
  use it.
- **`herdr agent list` already carries each agent's claude session id**, so the registry only has
  to record which children *this* orchestrator owns, and with which role.

## Spawn contract

One handle per child, serving as the Herdr agent name, the Claude session `--name`, and the
registry key. Herdr constrains it to `[a-z][a-z0-9_-]{0,31}`.

1. Guard `HERDR_ENV=1`, read `HERDR_WORKSPACE_ID`.
2. `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <cwd> --label <name> --no-focus`.
3. `herdr agent start <name> --kind claude --pane <root pane> -- --agent <role> --name <name>
   --session-id <uuid> --permission-mode acceptEdits [--model <m>]`.
4. Record ownership in `~/.claude/herdr-subagents/<parent-session-id>/registry.json`.
5. Return the handle. Never block.
6. The orchestrator sends the task with `SendMessage`, with `notify_when_idle: true`.

Every role body ends with the same reply contract: report the final summary to the sender of the
task by `SendMessage`; if one decision materially blocks the work, send the question and stop
rather than guessing.

## What implementation added to those findings

- **An untrusted `--cwd` strands the child.** Claude Code shows its workspace trust dialog on
  first use of a directory, and Herdr returns `agent_not_ready` with the child parked on it.
  `hs.mjs` reads `~/.claude.json` and refuses to spawn there rather than leaving a dead tab.
  The working rule: `--cwd` a directory you already work in, `--add-dir` everything else.
- **Herdr launches the child by typing a PowerShell line** (`Start-Process -FilePath claude
  -ArgumentList '...'`) into the tab's shell, which on Windows is PowerShell 5.1. Its quoting
  survived a JSON `--settings` argument intact, but this is the reason roles are passed as
  `--agent <name>` rather than as a long `--append-system-prompt`.
- **Bare role names collide.** `SendMessage` refused an ambiguous `scout` because a same-named
  session existed on another machine over Remote Control. Spawned handles now default to
  `<role>-<4 hex>`; pass `--name` for something meaningful.
- **Stopping must not forget the child.** Closing the tab ends the process, not the session, so
  the registry entry is marked rather than deleted and `resume` can still replay it.
- **The two completion signals have very different latency.** A child's own `SendMessage` reply
  arrived mid-turn, seconds after it finished, every time. The `notify_when_idle` notices for the
  same children arrived batched at the orchestrator's next turn boundary - one of them about 25
  minutes after the turn it reported. So the child's message is the result channel; the notice is
  a backstop that says a child finished or died, and it may be stale when it lands. It does report
  an exit (`has exited before going idle`), which is how a dead child is distinguished from a slow
  one.
- **The transcript's last assistant text is not the result.** A child that reports correctly does
  so with a `SendMessage` tool call and often prints something afterwards. `hs.mjs result` returns
  the last `SendMessage` argument when there is one, and falls back to the last text.

## Fallback

If cross-session messaging is ever unavailable (older Claude Code, a provider without it, a
container boundary), the async path still holds: run
`herdr agent wait <name> --until idle` as a background command and extract the last assistant
message from the child's transcript when it exits. Verified working in step 6 above.
