---
name: herdr-subagents
description: Delegate work to Claude Code subagents that each run in their own background tab in the orchestrator's Herdr workspace, visible and attachable, reporting back as cross-session messages. Use when asked to fan out work across agents, delegate to a scout/researcher/worker/reviewer, spawn a subagent in a Herdr tab, run agents in parallel where the user can watch them, or check on, steer, resume, or stop those children. Requires HERDR_ENV=1.
---

# Herdr subagents

A child spawned this way is a full Claude Code session in its own Herdr tab: the user can watch
it, click into it, take it over, and interrupt it. It has its own context window and reports back
to you as a message.

Use this instead of the Task tool when the user wants to *see* the work happen, take a child over
by hand, or keep a child alive across several exchanges. Use the Task tool when you just want a
result and nobody needs to watch — it is cheaper and has no tabs to clean up.

The script referenced below is `${CLAUDE_PLUGIN_ROOT}/scripts/hs.mjs`. If that variable is not
set, it sits two directories up from this file, at `<plugin>/scripts/hs.mjs`.

## Before spawning anything

```bash
node "$HS" doctor        # HS = <plugin>/scripts/hs.mjs
```

It checks that you are inside Herdr, that this Claude Code can send and receive cross-session
messages, and that the roles parse. If it fails, say so and stop — none of the rest works without
it.

## The loop

**1. Spawn.** Returns immediately with a handle; it never blocks.

```bash
node "$HS" spawn --role scout --cwd "<the directory the task is about>"
```

The handle in the returned JSON (`name`) is the child's Herdr tab label *and* its message
address. Pass `--name <handle>` to choose it yourself — do that when you are spawning several and
want to tell them apart later (`auth-scout`, `perf-scout`). Add `--model <alias>` for a cheaper
child, and `--add-dir <path>` for each directory outside `--cwd` the child may read.

**2. Send the task with `SendMessage`, not on the command line.** The spawn leaves the child idle
on purpose. The task must arrive as a message so the child receives your reply address with it.

```
SendMessage({ to: "<handle>", message: "<the whole task>", notify_when_idle: true })
```

Put everything the child needs in that message. It does not inherit one word of this
conversation — no file paths you have been discussing, no decisions already made, no context from
earlier turns.

`notify_when_idle: true` is a backstop, not the result channel: it fires once when the child next
goes idle or exits, so you still hear about a child that died without answering. Expect it to be
late - it lands at your own turn boundary and can arrive long after the child actually finished.
The child's own reply is what arrives promptly.

**3. Carry on.** Do not poll, do not loop on `hs list`, do not send "are you done?". The result
arrives on its own as a `<cross-session-message>` and starts a new turn here. Work on something
else, or tell the user what you dispatched and wait.

**4. Report and clean up.** Relay what the child found — the user cannot see its message as a
result, only as a message. Then close the tab:

```bash
node "$HS" stop <handle>          # or: stop-all
```

Only ever stop children this session spawned. The script refuses the rest.

## Roles

```bash
node "$HS" roles
```

| Role | What it is for |
| --- | --- |
| `scout` | Read-only recon: locate code, map structure, report paths and line numbers |
| `researcher` | External research with sources; reads the web, cites what it used |
| `worker` | Implementation: reads, edits, runs commands, reports what changed |
| `reviewer` | Reviews a change and returns findings; fixes nothing |

Each role carries its own tool allowlist, so a `scout` cannot write files no matter what the task
says, and its own model and effort, so recon is not billed like review:

| Role | Model | Effort |
| --- | --- | --- |
| `scout` | sonnet | low |
| `researcher` | sonnet | medium |
| `worker` | sonnet | high |
| `reviewer` | opus | high |

A child inherits neither the model nor the effort of this session - it is a separate session, not
a teammate - so the role decides, and `--model` / `--effort` at spawn override it. Raise the effort
for a genuinely hard task; do not raise it by reflex. Note that Haiku does not support effort at
all, so `--model haiku --effort high` silently gets you no extra reasoning. Project roles in `.claude/agents/` and user roles in `~/.claude/agents/` are picked up too,
and shadow the bundled ones by name.

## Choosing the working directory

`--cwd` must be a directory Claude Code already trusts, or the child stalls at startup on the
trust dialog. The script checks this and refuses rather than stranding a tab. The safe default is
the directory you are working in now; reach anywhere else with `--add-dir`. A child that hits a
path outside both shows up as `blocked`, waiting on a permission prompt.

## Fan-out

Spawn each child, then send each its task. Three to five is the useful range; each one is a
separate Claude Code session with its own token cost, and past that the coordination costs more
than the parallelism buys.

Give each a distinct handle and a task that does not overlap another's files. Their results
arrive independently and in any order — handle each as it lands rather than waiting for a set.

## Steering, questions, and blocked children

**To steer a running child**, message it: `SendMessage({ to: "<handle>", message: "..." })`. It
reads the message between tool calls without losing its place.

**When a child asks you something**, it has stopped and is waiting. Answer with `SendMessage` and
it picks straight up. If the question is genuinely the user's to answer, ask the user first — do
not invent an answer on the child's behalf.

**When `hs list` shows a child `blocked`**, Herdr has spotted an approval or question dialog.
Look, then surface it:

```bash
node "$HS" list
herdr agent read <handle> --source detection --lines 40
```

Never answer that dialog for the user with `herdr agent send-keys`. Tell them what is being asked
and let them decide, or cancel the child and respawn it with the access it needed.

## When a result never arrives

The child's transcript is the authority. This returns the message it reported, or its last
words if it never reported one:

```bash
node "$HS" result <handle>
```

`herdr agent read` only shows what is still on screen, so use it to diagnose a stuck child, not to
recover a finished answer.

## Resuming

Stopping a child closes its tab but not its Claude session, so it stays resumable. Bring it back
with its full history, in a new tab:

```bash
node "$HS" resume <handle>
```

Then message it as before. Use this when a finished child needs a follow-up, instead of spawning a
fresh one that knows nothing. `node "$HS" forget <handle>` drops a stopped child from the registry
for good.

## Costs and limits

Every child is a full session billed on its own. Delegate work that is genuinely separable and
large enough to be worth a whole context window; do the small stuff yourself. Children cannot
spawn children through this skill, and a child never inherits your conversation.
