# Codex as the orchestrator

The Codex adapter ports the orchestration contract, not the external-process implementation used
by Pi and Claude Code. Current Codex releases already provide native subagent threads, so the
adapter is a skills-only Codex plugin.

## Primitive mapping

| Project concept | Pi implementation | Claude implementation | Codex implementation |
| --- | --- | --- | --- |
| Async spawn | Extension tool plus watcher | Herdr tab plus `SendMessage` | Native subagent spawn |
| Child identity | Registry handle | Claude session name and ownership registry | Native child id and canonical task path |
| Result delivery | Pi steer | Cross-session message | Native child completion mailbox |
| Live steering | `subagent_message` | `SendMessage` | Native child message/input |
| Follow-up | Resume stored Pi session | Resume Claude session | Start a follow-up turn on the same child thread |
| Question | `ask_question` sidecar | Child message to parent | Child message to its parent thread |
| Status | Pi widget plus Herdr | Registry plus Herdr | Native agent tree and Codex Subagents UI |
| Cancel | Close owned tab/session | Close owned tab; keep transcript | Interrupt or close the owned child thread |
| Nested work | Enforced role allowlist | Disabled by the Claude launcher | Native nested task paths, constrained by the role contract |

## Why there is no Codex registry or watcher

Codex owns thread persistence, result routing, follow-up delivery, hierarchy, and completion. A
second filesystem registry would create competing identities and stale lifecycle state without
adding capability. The skill retains the native child handle returned at spawn and uses Codex's
own collaboration operations for every later action.

The same reasoning rules out a callback hook. Native child completion already wakes and returns a
result to the parent agent tree; intercepting it through terminal text would discard structured
thread identity and make approval or question handling ambiguous.

## Topology difference

Pi and Claude Code need separate processes to get independent contexts, so Herdr places each one
in a background tab. Codex subagents are independent threads inside the current Codex runtime.
They are inspectable through the Subagents UI and `/agent`, but Herdr correctly detects only the
parent Codex process in its terminal pane.

Launching separate `codex` CLI processes in Herdr tabs is not equivalent. Those sessions do not
join the parent's native task tree and have no documented native child handle or parent mailbox.
The Codex skill therefore does not create tabs or claim external sessions are native children.

## Roles and permissions

The canonical role catalog generates one Codex reference per role. The orchestrator reads the
chosen reference and includes its full contract in the spawn message, along with a self-contained
task brief. Model and reasoning defaults are applied only when the current surface supports them.

Codex reapplies the parent turn's live sandbox and approval policy to children. Consequently,
`read-only` in a bundled role is an agent behavior contract, not a security boundary. Users who
need enforced narrowing should define a Codex custom agent with `sandbox_mode = "read-only"` and
use that agent type; the plugin does not mutate user-level Codex configuration during install.

## Packaging

The repository root is the plugin root. [`.codex-plugin/plugin.json`](../.codex-plugin/plugin.json)
points to [`skills/`](../skills/), and the `herdr-subagents` skill contains only orchestration
instructions plus generated role references. No MCP server or hook is required.
