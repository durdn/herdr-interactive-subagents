# herdr-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), hosted natively by [Herdr](https://herdr.dev). Each subagent runs in a **background tab in the orchestrator's current Herdr workspace**. The spawn returns immediately; completion is steered back into the orchestrator as a new pi turn.

## Acknowledgements

This project was forked from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents). We are grateful to its authors and contributors, and to everyone whose work preceded theirs. This repository is only the latest link in that development chain.

This repository is both:

- a pi package that provides the orchestration tools and rich TUI rendering; and
- a Herdr plugin manifest with setup/doctor actions, suitable for `herdr plugin install` and marketplace discovery.

## Topology

If the orchestrator runs in workspace `w1`, every child and nested child is created with an explicit `--workspace w1` target. The extension resolves the caller pane with `--current`, so this remains correct even if the live orchestrator pane was moved after launch:

```text
Workspace w1
├─ Tab: orchestrator       pi
├─ Tab: scout              pi subagent
├─ Tab: dark-mode          pi subagent
└─ Tab: researcher         pi subagent
```

Tabs are created with `--no-focus`, so parallel spawning does not take the keyboard away from the orchestrator. Herdr's Agents view remains the primary overview for semantic `working`, `blocked`, `done`, and `idle` state; the extension also keeps its compact in-pi status widget and detailed tool activity.

## Requirements

- [Herdr](https://herdr.dev) 0.8+
- [pi](https://github.com/badlogic/pi-mono), launched inside a Herdr pane
- Herdr's pi integration (recommended for authoritative lifecycle and restore):

```bash
herdr integration install pi
```

Nested tmux is neither required nor supported. Herdr must see the actual agent process in each tab.

## Install

### As a Herdr plugin

```bash
herdr plugin install durdn/herdr-interactive-subagents
herdr plugin action invoke durdn.interactive-subagents.install-pi
herdr plugin action invoke durdn.interactive-subagents.doctor
```

Restart pi or run `/reload` after installing the companion pi package.

### Directly as a pi package

```bash
pi install git:github.com/durdn/herdr-interactive-subagents
```

For local development:

```bash
herdr plugin link "$PWD"
pi install "$PWD"
```

## How it works

`subagent()` resolves the calling pane's current workspace, creates a new Herdr tab in that workspace, preserves the requested working directory, and launches a sandboxed pi session in the tab's root pane. The extension watches the child session without blocking the parent. On completion it closes the child tab, extracts the final assistant message and usage, and sends a `subagent_result` steer to the orchestrator.

Parallel spawns create parallel sibling tabs. Nested spawns inherit Herdr's workspace context, so a worker's children stay in the same workspace rather than following whichever workspace another UI client happens to focus.

If shell startup is unusually slow:

```bash
export HERDR_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

`PI_SUBAGENT_SHELL_READY_DELAY_MS` remains accepted as a compatibility fallback.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a subagent in a background Herdr tab (async) |
| `subagent_message` | Message a child by name; steer it live or resume its finished pi session |
| `subagent_cancel` | Cancel one running child and clean up its tab/widget entry |
| `subagent_cancel_all` | Cancel all running children and clear their tabs/widget entries |
| `subagents_list` | List discoverable role definitions |
| `ask_question` | Child-only: ask the orchestrator one question and remain parked for its reply |

There is also `/subagent <agent> <task>` for direct use.

### Spawn

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the toggle" });
```

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `agent` | string | required | Discoverable agent role |
| `task` | string | required | Task prompt |
| `name` | string | role name | Unique Herdr tab/widget handle; duplicates are suffixed |
| `model` | string | role model | Model override |
| `cwd` | string | role cwd | Child working directory |

### Message or resume

```typescript
subagent_message({ name: "scout", message: "Also inspect the middleware" });
```

- **Running:** submits the message to the live Herdr pane and returns immediately.
- **Finished:** resumes the original pi session with the exact snapshotted sandbox and reclaims the name; its result arrives asynchronously.
- **Cancellation:** use `subagent_cancel({ name })` or `subagent_cancel_all({})`; manually closed Herdr tabs are also detected and removed from the widget.

Name mappings live under the orchestrator session's `artifacts/<sessionId>/subagent-registry.json` and survive pi restarts.

### Questions

A child can call `ask_question` when one decision materially affects its work. It parks instead of auto-exiting, and the parent receives a steer containing the question. Reply with `subagent_message({ name, message })`. Separate children can wait independently.

## Bundled roles

| Role | Model | Tools | Purpose |
| --- | --- | --- | --- |
| `scout` | parent model | read-only code tools | Fast codebase reconnaissance |
| `researcher` | parent model | bundled read-only web tools | Sourced external research |
| `worker` | parent model | read/write/edit/bash/web plus spawning | General implementation |

## Custom roles

Put role files in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Priority is project > global > bundled.

```markdown
---
name: reviewer
description: Reviews a change
thinking: medium
tools: read, grep, find
session-mode: lineage-only
system-prompt: append
auto-exit: true
---

Review the requested change and return actionable findings.
```

Important frontmatter:

- `model`: optional explicit override; omit it to inherit the orchestrator's active model.
- `tools`: strict allowlist; extension-backed tools are loaded only when requested.
- `subagent_agents`: grants the spawning tools and restricts nested spawn targets.
- `session-mode`: `standalone`, `lineage-only`, or `fork`.
- `system-prompt`: `append` or `replace` for the role body.
- `auto-exit`: close after a normally completed turn.
- `interactive`: suppress parent wakeups for status transitions when user-driven.
- `cwd`: default working directory.
- `skills`: comma-separated pi skills loaded into the child.
- `cli: claude`: optional legacy Claude Code launch path; pi is the primary and fully sandboxed path.

Resume replays the original resolved model, thinking level, identity, cwd, config directory, tool allowlist, backing extensions, and nested spawn allowlist. Missing legacy loadouts are refused rather than resumed unrestricted.

## Status and configuration

Copy `config.json.example` to `config.json` to override package-local status behavior:

```json
{
  "status": { "enabled": true, "notifyParent": false }
}
```

The Pi widget shows launch/activity details. `notifyParent` is off by default so status transitions do not wake the orchestrator and consume a model turn; set it to `true` for proactive stalled/recovered messages. Herdr independently provides workspace/tab rollups, agent navigation, unseen `done` state, and blocked-agent visibility.

## Tests

```bash
npm test                 # unit tests
npm run test:surface     # real Herdr tabs, no model calls; run inside Herdr
npm run test:integration # full lifecycle tests with model calls
```

## Claude Code as the orchestrator

pi cannot drive Claude Code on a Claude subscription, so this repository also ships a second,
independent path: **Claude Code orchestrates, and each child is a Claude Code session in its own
background tab in the orchestrator's Herdr workspace.** Same topology, no pi in the loop.

It lives in [`claude-plugin/`](claude-plugin) and is a Claude Code plugin - one skill, four slash
commands, four roles, and a thin CLI backed by one import-safe implementation module:

```bash
node claude-plugin/scripts/hs.mjs install    # links it into ~/.claude/skills/
node claude-plugin/scripts/hs.mjs doctor
```

Restart Claude Code afterwards. Then, inside a Herdr pane:

```text
/subagent scout map the auth module
/subagents
/subagent-stop --all
```

The design deliberately implements almost nothing. Claude Code 2.1.246 supplies the pieces this
pi extension had to build by hand - `SendMessage` cross-session delivery is the async callback,
session names are the address registry, `--session-id` plus `--resume` is the session sandbox,
and a child's question to its parent is just a message. Herdr supplies the tab, the visibility,
and the `working`/`blocked`/`done` lifecycle. What is left is the spawn contract and cleanup.

[`docs/claude-orchestrator.md`](docs/claude-orchestrator.md) records the design and the spike that
verified each primitive on Windows. It supersedes the conclusion of
[`docs/skill-only-design.md`](docs/skill-only-design.md), which asked this question a version of
Claude Code too early and answered "synchronous delegation only".

## Development lineage

The upstream lineage also includes [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). That earlier tmux-focused work established the current session sandbox, supervision, and async result architecture; this version replaces the multiplexer surface with Herdr workspace/tab primitives.

## License

MIT
