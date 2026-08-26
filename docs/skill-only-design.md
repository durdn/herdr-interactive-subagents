# Skill-only orchestration design (future, not implemented)

## Question

Can Herdr's native layout and agent APIs replace the pi extension so a generic orchestrator such as Claude Code or Codex needs only a skill file?

## Short answer

**Mostly, for explicit synchronous delegation; not yet for the complete asynchronous experience in this package.** Herdr already owns the hard cross-agent primitives: create a tab in a specific workspace, start a recognized agent, prompt it, wait on semantic lifecycle state, read its terminal, and preserve the session. A skill can teach any supported orchestrator to compose those commands. What a skill cannot provide is a resident event loop, durable name registry, automatic result injection into the orchestrator's conversation, restricted role/loadout enforcement across arbitrary CLIs, or the child-side `ask_question` callback.

## Herdr-native flow

A generic skill could:

1. Verify `HERDR_ENV=1` and capture `HERDR_WORKSPACE_ID`.
2. Create a background tab in that exact workspace with `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label <name> --no-focus`.
3. Parse `.result.root_pane.pane_id`.
4. Start a supported agent with `herdr agent start <unique-name> --kind claude|codex|pi --pane <id> -- <native-args>`.
5. Submit work with `herdr agent prompt <name> <task> --wait`.
6. Inspect `blocked` states before answering interactive UI, and read the final transcript with `herdr agent read`.
7. Keep or close the tab according to the user's policy.

This is enough for a skill-driven orchestrator that is willing to wait in the tool call, or to revisit named agents manually. It is portable across agents because the orchestration contract is Herdr's CLI rather than pi's extension API.

## Gaps versus this pi extension

| Capability | Herdr + skill | Current pi extension |
| --- | --- | --- |
| Same-workspace background tabs | Native | Yes |
| Agent detection and `working`/`blocked`/`done` | Native | Native Herdr plus child activity details |
| Start Claude/Codex/Pi generically | Native | Pi and optional Claude path |
| Automatic async result delivered as a new orchestrator turn | No resident callback in a skill | `pi.sendMessage(..., deliverAs: "steer")` |
| Persistent logical name -> finished session mapping | Live Herdr names only; cleared on exit | Registry and resumable pi session |
| Exact model/tool/system-prompt sandbox replay | CLI-specific and hard to normalize | Pi loadout sidecar and default-deny replay |
| Nested spawn allowlists | Instruction-only unless each CLI adds enforcement | Enforced by the extension |
| Child asks parent and remains parked | Herdr can expose `blocked`, but has no parent-message routing convention | `ask_question` sidecar + steer |
| Rich orchestrator-local widget/result renderer | Herdr sidebar only | Pi widgets and custom messages |

## Recommended future shape

Keep the current pi extension as the full async implementation. Add a separate `skills/herdr-subagents/SKILL.md` only when its semantics are intentionally narrower:

- supported kinds are selected explicitly;
- orchestration is synchronous (`agent prompt --wait`) by default;
- async mode means "start and return the Herdr agent name," not automatic callback;
- the skill never claims sandbox enforcement;
- blocked agents are inspected and surfaced to the user, never answered automatically;
- all tabs are created with explicit `--workspace "$HERDR_WORKSPACE_ID"` and `--no-focus`.

A fully generic async replacement would need one additional primitive outside a skill: a small resident broker/plugin that subscribes to Herdr agent events and can inject a completed result into the calling agent's native session. Once Herdr exposes a cross-agent prompt/callback association (or each harness exposes a stable inbound message API), the pi-specific watcher and registry can be retired.
