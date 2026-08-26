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
- **A task needs a reply address, not necessarily a message.** The original reading of this was
  that `claude "<task>"` arrives with no address, so the task had to come over `SendMessage`.
  Half right: the address is what matters, and it does not have to travel on a message. The
  orchestrator's own inbox is in `CLAUDE_CODE_MESSAGING_SOCKET`, and `SendMessage` accepts that
  raw `uds:\\.\pipe\...` string as `to` — the same value a child copies out of an incoming
  message's `from`. Writing it into a task brief the child reads at startup delivers task and
  address together, and collapses spawn-then-message into one call. `SendMessage` is still the
  channel for everything after the launch: steering, answers, follow-ups.
- **New Herdr tabs run Windows PowerShell 5.1** (`$PSEdition = Desktop`). Prefer `--agent <role>`
  over long quoted `--append-system-prompt` arguments so nothing depends on shell quoting.
- **Permission class governs delivery, but `acceptEdits` is the wrong default.** It auto-accepts
  edits and then stops the child dead on every Bash and WebFetch approval, in a background tab
  nobody is watching — three of five children in the 2026-08-26 battery parked that way. Children
  now default to `auto`, the same class the orchestrator runs in; a probe child under `auto` ran
  pwsh, executed a script, listed files and did a WebFetch with no prompt, and its reply was
  delivered normally. `bypassPermissions` is NOT the alternative: a child in that class would have
  every message it sends held for approval, which breaks reporting outright.
- **`herdr agent list` already carries each agent's claude session id**, so the registry only has
  to record which children *this* orchestrator owns, and with which role.

## Spawn contract

One handle per child, serving as the Herdr agent name, the Claude session `--name`, and the
registry key. Herdr constrains it to `[a-z][a-z0-9_-]{0,31}`.

1. Guard `HERDR_ENV=1`, read `HERDR_WORKSPACE_ID`.
2. `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <cwd> --label <name> --no-focus`.
3. `herdr agent start <name> --kind claude --pane <root pane> -- --agent <role> --name <name>
   --session-id <uuid> --permission-mode auto [--model <m>]`.
4. Record ownership in `~/.claude/herdr-subagents/<parent-session-id>/registry.json`.
5. Return the handle. Never block.
6. With `--task`: the task is written to `<registry dir>/briefs/<name>.md` alongside the reply
   address, that directory is granted with `--add-dir`, and the child is seeded with a one-line
   positional prompt telling it to read the brief. Without `--task`: the child stays idle and the
   orchestrator sends the task with `SendMessage`, with `notify_when_idle: true`.

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
- **A child inherits neither the orchestrator's model nor its effort.** It is an ordinary session,
  not a teammate, so it resolves its own: `--model` if given else the account default, and effort
  by the documented precedence (`CLAUDE_CODE_EFFORT_LEVEL` > the configured `effortLevel` > the
  model default of `high`). On this machine that meant every child read `effortLevel: xhigh` from
  user settings and came up as `Sonnet 5 with xhigh effort` - a scout running a grep billed at the
  deepest setting. Roles now state `model:` and `effort:` themselves, and both go into the
  recorded argv so `resume` replays the same loadout.
- **Haiku 4.5 does not support effort**, so `--effort` is accepted and silently inert there. The
  effort-capable models are Fable 5, Opus 5, Sonnet 5, Opus 4.8/4.7 (`low`-`max`) and Opus
  4.6/Sonnet 4.6 (no `xhigh`). Read the effort back from the child's session header
  (`Sonnet 5 with low effort`), which is the only place it is visible - it is absent from the
  transcript, and `CLAUDE_EFFORT` is not exported in every session.
- **A trailing positional prompt is swallowed by the preceding flag.** `claude`'s `--add-dir`,
  `--allowed-tools`, `--mcp-config` and friends are variadic, so `--add-dir <dir> "<prompt>"`
  parses the prompt as a second directory. The child then boots to an idle prompt with no task and
  no error, which is indistinguishable from a child still thinking — the failure mode is silence,
  not a message. The seed prompt goes first, before any flag.
- **The seed prompt must stay out of the recorded argv.** `resume` replays argv; a replayed seed
  would re-run the finished task on the revived child.
- **A skill loaded from `~/.claude/skills` cannot locate its own plugin.** `CLAUDE_PLUGIN_ROOT`
  is unset there, and the entry is a junction, so a relative `../../scripts/hs.mjs` in SKILL.md
  normalises lexically to `~/.claude/scripts/hs.mjs` before the filesystem ever sees it. Every
  reader then spends three or four tool calls hunting for the script. `install` now writes a
  forwarding shim at the fixed path `~/.claude/herdr-subagents/hs.mjs`, which SKILL.md names
  verbatim: stable, machine-independent, and correct under `~` expansion in both shells. `spawn`
  rewrites it when stale, so a moved checkout self-heals without an install.
- **The transcript's last assistant text is not the result.** A child that reports correctly does
  so with a `SendMessage` tool call and often prints something afterwards. `hs.mjs result` returns
  the last `SendMessage` argument when there is one, and falls back to the last text.

## Fallback

If cross-session messaging is ever unavailable (older Claude Code, a provider without it, a
container boundary), the async path still holds: run
`herdr agent wait <name> --until idle` as a background command and extract the last assistant
message from the child's transcript when it exits. Verified working in step 6 above.
