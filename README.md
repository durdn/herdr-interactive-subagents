# herdr-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), hosted natively by [Herdr](https://herdr.dev). Each subagent runs in a **background tab in the orchestrator's current Herdr workspace**. The spawn returns immediately; completion is steered back into the orchestrator as a new pi turn.

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

Name mappings live under the orchestrator session's `artifacts/<sessionId>/subagent-registry.json` and survive pi restarts.

### Questions

A child can call `ask_question` when one decision materially affects its work. It parks instead of auto-exiting, and the parent receives a steer containing the question. Reply with `subagent_message({ name, message })`. Separate children can wait independently.

## Bundled roles

| Role | Model | Tools | Purpose |
| --- | --- | --- | --- |
| `scout` | `openrouter/z-ai/glm-5.3` | read-only code tools | Fast codebase reconnaissance |
| `researcher` | `openrouter/z-ai/glm-5.3` | web tools and safe bash | Sourced external research |
| `worker` | `openrouter/z-ai/glm-5.3` | read/write/edit/bash/web plus spawning | General implementation |

## Custom roles

Put role files in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Priority is project > global > bundled.

```markdown
---
name: reviewer
description: Reviews a change
model: openrouter/z-ai/glm-5.3
thinking: medium
tools: read, grep, find
session-mode: lineage-only
system-prompt: append
auto-exit: true
---

Review the requested change and return actionable findings.
```

Important frontmatter:

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
  "status": { "enabled": true }
}
```

The Pi widget shows launch/activity details. Herdr independently provides workspace/tab rollups, agent navigation, unseen `done` state, and blocked-agent visibility.

## Tests

```bash
npm test                 # unit tests
npm run test:surface     # real Herdr tabs, no model calls; run inside Herdr
npm run test:integration # full lifecycle tests with model calls
```

## Skill-only future

Herdr's native `tab create`, `agent start`, `agent prompt --wait`, `agent wait`, and `agent read` primitives can support a narrower, generic Claude Code/Codex skill. A skill alone cannot provide the current resident async callback, persistent finished-session registry, sandbox replay, nested allowlist enforcement, or `ask_question` routing. The design exploration is documented in [`docs/skill-only-design.md`](docs/skill-only-design.md); no generic skill is shipped yet.

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). The earlier tmux-focused fork established the current session sandbox, supervision, and async result architecture; this version replaces the multiplexer surface with Herdr workspace/tab primitives.

## License

MIT
