# Codex as the orchestrator

## Install from a checkout

Use the repository's cross-harness installer rather than creating a link by hand:

```bash
npm run harness:install -- codex
npm run harness:doctor -- codex
```

The installer idempotently links this checkout's `skills/herdr-subagents` directory into the
user-wide `~/.agents/skills/herdr-subagents` location and protects any foreign file already at that
path. It does not create, configure, or publish a marketplace. Start a new Codex session after
installing so the skill catalog refreshes.

The same command accepts `pi`, `claude`, or `all`; use `harness:uninstall` for the inverse operation.

## Topology

The Codex adapter now uses the same visible process topology as the Pi and Claude adapters. A child
is an independent interactive Codex CLI in a background tab in the leader's Herdr workspace:

```text
Herdr workspace
├─ leader tab       Codex orchestrator
├─ auth-scout       independent Codex session
├─ docs-research    independent Codex session
└─ fix-worker       independent Codex session
```

These processes are not members of Codex's native subagent tree. They therefore do not have native
child handles or a native parent mailbox. The adapter says so explicitly and uses Herdr as the
transport instead of presenting the two topologies as equivalent.

## Primitive mapping

| Project concept | Pi implementation | Claude implementation | Codex implementation |
| --- | --- | --- | --- |
| Async spawn | Extension tool plus watcher | Herdr tab plus `SendMessage` | Herdr tab plus prompt and watcher |
| Child identity | Registry handle | Claude session name and ownership registry | Codex session id and parent ownership registry |
| Result delivery | Pi steer | Cross-session message | Herdr notification plus explicit transcript retrieval |
| Live steering | `subagent_message` | `SendMessage` | `herdr agent prompt` |
| Follow-up | Resume stored Pi session | Resume Claude session | Resume retained Codex session |
| Status | Pi widget plus Herdr | Registry plus Herdr | Registry plus live Herdr agent state |
| Cancel | Close owned tab/session | Close owned tab; keep transcript | Close owned tab; keep transcript |

The launcher lives at
[`skills/herdr-subagents/scripts/codex-subagents.mjs`](../skills/herdr-subagents/scripts/codex-subagents.mjs).
It stores only the leader-to-child ownership records Herdr does not own. Live lifecycle state always
comes back from Herdr. The registry is parent-session-scoped in the system temporary directory, so
it neither dirties the repository nor lets one leader close another leader's tab.

## Result delivery

After submitting the initial prompt, the launcher starts a detached watcher. The watcher waits on
Herdr's semantic `done`, `blocked`, or `unknown` state instead of polling. A completed or blocked
child produces a native Herdr notification containing only its name and status. It never inserts
markup or a synthetic user prompt into the leader's transcript. The leader collects trusted output
with `result <name> --wait`; Herdr's toast is user-facing status, not a hidden Codex mailbox.

The full role and task are written to a parent-scoped temporary brief. Herdr submits only a short
instruction pointing Codex at that file, then requires a state-observed submission handshake.
This avoids the Codex bracketed-paste threshold, where a long fire-and-forget prompt can remain in
the composer without consuming Enter.

`result` finds the Codex session id reported by Herdr and reads the Codex JSONL transcript. The CLI
is launched with `--no-alt-screen`, so retained Herdr scrollback is a useful fallback when a
transcript is unavailable.

## Ledger

The registry entry is also the child's ledger. Each brief carries an id (`b1` the assignment, `b2`
onward the follow-ups), the delivery the launcher observed (`confirmed` after Herdr saw the state
change, `sent` when the child was working and Codex queued the text) and the receipt: the timestamp
of the transcript's user message that quotes the brief's file name. `result` types its text from the
transcript's `task_started` and `task_complete` events, `final`, `progress`, `stale` or `blocked`,
with the `Closes:` ids the child named. `list` and `result --json` add elapsed and active minutes,
the transcript's token usage, and an `overBudget` flag against a `--budget-min` deadline; the
watcher notifies past that deadline and stops nothing. Waits accept `idle`, the state Herdr shows
for a finished tab the user has looked at. Resume keeps the recorded model and reasoning.

The field run that paid for this: a follow-up sent to a working child returned a timeout although the
child read it; `result --wait` timed out while three finished children sat `idle` with their finals
readable; a wording follow-up displaced a three-defect correction and the next final reported only
the wording; a resume without flags came back on the role's default model instead of the session's.

## Permission propagation

Codex's native children inherit the current sandbox and approval mode inside one runtime. A new CLI
process does not. The launcher therefore reads `CODEX_PERMISSION_PROFILE`, which the Codex host
injects into the leader's command environment, and maps the built-in profiles to explicit launch
arguments:

| Leader profile | Child launch boundary |
| --- | --- |
| `:danger-full-access` | `--dangerously-bypass-approvals-and-sandbox` |
| `:workspace` | `--sandbox workspace-write --ask-for-approval on-request` |
| `:read-only` | `--sandbox read-only --ask-for-approval on-request` |
| named custom profile | `-c default_permissions="<profile>"` |

This explicit mapping fixes the practical failure where a leader granted full access still spawned
children at their configured default and every child asked for approval again. The CLI flags are
the enforcing mechanism; the profile environment value is only the leader-side source signal.

Role access remains a behavioral contract within that boundary. A scout is instructed not to edit,
but a user who grants the entire delegated tree full access does not get a new approval boundary per
role.

## Windows executable resolution

npm installs `codex` on Windows as PowerShell and cmd shims. Herdr's agent launcher uses
`Start-Process -FilePath codex`, and Windows PowerShell 5.1 rejects those shims with `%1 is not a
valid Win32 application`. The adapter resolves the platform package's actual `codex.exe` and
prepends its directory to the child tab's `PATH`, retaining Herdr's normal `--kind codex` startup
and agent detection. `HERDR_CODEX_EXE` is an explicit override for nonstandard installations.

## Lifecycle

The skill documents the stable installed path. The principal commands are:

```bash
node ~/.agents/skills/herdr-subagents/scripts/codex-subagents.mjs spawn --role scout --name map --cwd <dir> --task <brief> [--budget-min <n>]
node ~/.agents/skills/herdr-subagents/scripts/codex-subagents.mjs list
node ~/.agents/skills/herdr-subagents/scripts/codex-subagents.mjs message map --message <follow-up>
node ~/.agents/skills/herdr-subagents/scripts/codex-subagents.mjs result map --wait --timeout 300000
node ~/.agents/skills/herdr-subagents/scripts/codex-subagents.mjs stop map
node ~/.agents/skills/herdr-subagents/scripts/codex-subagents.mjs resume map --task <follow-up>
node ~/.agents/skills/herdr-subagents/scripts/codex-subagents.mjs forget map
```

Spawn creates and records the tab before starting the agent. An uncertain startup remains recorded
and open for diagnosis rather than deleting a process that may have started late. Stop operates only
on the exact tab id in the current parent's registry.

## Roles and packaging

The canonical role catalog generates one Codex reference per role. The launcher loads the chosen
reference and prepends its full contract to a self-contained task brief. Model and reasoning values
are passed as Codex CLI defaults and can be explicitly overridden.

The repository root remains the skills-only plugin root.
[`.codex-plugin/plugin.json`](../.codex-plugin/plugin.json) points to [`skills/`](../skills/); no MCP
server, marketplace, or Codex configuration mutation is required.
