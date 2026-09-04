# herdr-interactive-subagents

Interactive subagent workflows for [pi](https://github.com/badlogic/pi-mono), Claude Code, and Codex, integrated with [Herdr](https://herdr.dev). Pi and Claude Code children run as full sessions in background Herdr tabs. The Codex adapter uses Codex-native inspectable agent threads and its built-in async lifecycle.

## Acknowledgements

This project was forked from [amosblomqvist/pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents). We are grateful to its authors and contributors, and to everyone whose work preceded theirs. This repository is only the latest link in that development chain.

This repository is all of:

- a pi package that provides the orchestration tools and rich TUI rendering; and
- a Claude Code plugin that launches independent Claude sessions in Herdr tabs;
- a Codex skills-only plugin that composes Codex's native collaboration tools; and
- a Herdr plugin manifest with setup/doctor actions, suitable for `herdr plugin install` and marketplace discovery.

## Pi and Claude tab topology

For the process-backed Pi and Claude adapters, if the orchestrator runs in workspace `w1`, every child and nested child is created with an explicit `--workspace w1` target. The Pi extension resolves the caller pane with `--current`, while the Claude launcher uses the orchestrator's injected workspace id:

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
| `name` | string | role name | Unique Herdr tab/widget handle; explicit duplicates fail, defaults are suffixed |
| `model` | string | role model | Model override |
| `cwd` | string | role cwd | Child working directory |
| `budgetMin` | number | none | Wall-clock budget in minutes; an over-budget child is cancelled and its result arrives marked `over budget: <n> min` |

### Message or resume

```typescript
subagent_message({ name: "scout", message: "Also inspect the middleware" });
```

- **Running:** submits the message to the live Herdr pane and returns immediately.
- **Finished:** resumes the original pi session with the exact snapshotted sandbox and reclaims the name; its result arrives asynchronously.
- **Cancellation:** use `subagent_cancel({ name })` or `subagent_cancel_all({})`; manually closed Herdr tabs are also detected and removed from the widget.

Name mappings live under the orchestrator session's `artifacts/<sessionId>/subagent-registry.json` and survive pi restarts. Atomic claim directories beside the registry reserve names and exclude concurrent transcript resumes across processes. Existing registry-only sessions remain readable; their first resume acquires the new run claim before Herdr is mutated. An ownership claim retained after an ambiguous launch intentionally blocks automatic retry until the external state is diagnosed.

### Questions

A child can call `ask_question` when one decision materially affects its work. It parks instead of auto-exiting, and the parent receives a steer containing the question. Reply with `subagent_message({ name, message })`. Separate children can wait independently.

## Bundled roles

<!-- BEGIN GENERATED: pi-role-table -->
<!-- Generated by `npm run roles:generate` from `roles/catalog.json`; do not edit this file directly. -->
| Role | Model | Tools | Purpose |
| --- | --- | --- | --- |
| `scout` | parent model | read-only code tools | Fast codebase reconnaissance |
| `researcher` | parent model | bundled read-only web tools | Sourced external research |
| `worker` | parent model | read/write/edit/bash/web plus spawning | General implementation |
<!-- END GENERATED: pi-role-table -->

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
- `cli: claude`: deprecated legacy Claude Code launch path, retained for 4.x compatibility. Migrate the role to native Pi metadata, or use the dedicated Claude orchestrator described below. The legacy path and its hook files will be removed in a future major release. Pi shows this migration warning once per legacy role in each session.

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
npm run roles:check      # verify committed roles/tables match the catalog
npm test                 # role freshness plus unit tests
npm run test:surface     # real Herdr tabs, no model calls; run inside Herdr
npm run test:integration # full lifecycle tests with model calls
```

## Claude Code as the orchestrator

pi cannot drive Claude Code on a Claude subscription, so this repository also ships a second,
independent path: **Claude Code orchestrates, and each child is a Claude Code session in its own
background tab in the orchestrator's Herdr workspace.** Same topology, no pi in the loop.

It lives in [`claude-plugin/`](claude-plugin) and is a Claude Code plugin - one skill, four slash
commands, four roles, and a thin CLI backed by one import-safe implementation module:

<!-- BEGIN GENERATED: claude-role-table -->
<!-- Generated by `npm run roles:generate` from `roles/catalog.json`; do not edit this file directly. -->
| Role | Model | Effort | Tools | Purpose |
| --- | --- | --- | --- | --- |
| `scout` | sonnet | low | `Read, Glob, Grep, SendMessage` | Fast codebase reconnaissance |
| `researcher` | sonnet | medium | `Read, Glob, Grep, WebSearch, WebFetch, SendMessage` | Sourced external research |
| `worker` | sonnet | high | `Read, Glob, Grep, Bash, Edit, Write, WebSearch, WebFetch, TodoWrite, SendMessage` | General implementation |
| `reviewer` | opus | high | `Read, Glob, Grep, Bash, SendMessage` | Actionable change review |
<!-- END GENERATED: claude-role-table -->

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

## Codex as the orchestrator

Codex now supplies the orchestration layer directly: native child threads spawn asynchronously,
return results to the parent, accept live follow-ups, remain resumable, form a nested task tree,
and can be listed, waited on, interrupted, or closed. The repository therefore ships a thin
skills-only Codex plugin at [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json), with the
workflow in [`skills/herdr-subagents/`](skills/herdr-subagents/).

<!-- BEGIN GENERATED: codex-role-table -->
<!-- Generated by `npm run roles:generate` from `roles/catalog.json`; do not edit this file directly. -->
| Role | Model | Reasoning | Access contract | Purpose |
| --- | --- | --- | --- | --- |
| `scout` | gpt-5.6-terra | low | read-only | Fast codebase reconnaissance |
| `researcher` | gpt-5.6-terra | medium | read-only | Sourced external research |
| `worker` | gpt-5.6-sol | high | inherited writable | General implementation |
| `reviewer` | gpt-5.6-sol | high | read-only | Actionable change review |
<!-- END GENERATED: codex-role-table -->

The Codex path deliberately has no registry, watcher, callback hook, or terminal automation.
Codex owns those semantics for its native agent tree. It also means the topology differs from Pi
and Claude Code: children appear in Codex's Subagents UI (or `/agent` in the CLI), not as separate
Herdr terminal tabs. Starting independent `codex` processes in tabs would lose the native parent
mailbox and task-tree identity, so the skill refuses to present that as equivalent.

Role references are generated from the same canonical [`roles/catalog.json`](roles/catalog.json)
as the Pi and Claude definitions. The read-only labels are role contracts; Codex children inherit
the parent's live sandbox and approval policy unless the user separately configures a stricter
custom-agent sandbox.

For local development, validate the plugin and skill with:

```bash
python <plugin-creator>/scripts/validate_plugin.py .
python <skill-creator>/scripts/quick_validate.py skills/herdr-subagents
```

Install the packaged plugin through a Codex plugin marketplace, then start a new Codex thread so
the skill catalog is refreshed. The plugin requires current Codex releases with the stable
multi-agent feature enabled (it is enabled by default).

## Development lineage

The upstream lineage also includes [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). That earlier tmux-focused work established the current session sandbox, supervision, and async result architecture; this version replaces the multiplexer surface with Herdr workspace/tab primitives.

## License

MIT
