import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_CLAUDE_WARNINGS_KEY = Symbol.for("pi-subagents/legacy-claude-warnings");
const LEGACY_CLAUDE_DEPRECATION =
  "cli: claude compatibility path; migrate this role to native Pi, or use the dedicated Claude orchestrator. It remains available in 4.x but will be removed in a future major release.";

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
  deprecated?: true;
  deprecation?: string;
}

/** Only the request fields used while resolving an agent configuration. */
interface AgentConfigurationParams {
  cwd?: string;
  model?: string;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. `null` means no
 * restriction (top-level session, or an unrestricted child).
 */
export const SUBAGENT_ALLOWLIST: ReadonlySet<string> | null = (() => {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (!raw) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
})();

function getBundledAgentsDir(): string {
  return fileURLToPath(new URL("../../agents", import.meta.url));
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function resolveAgentDefinitionsByName(): Map<string, ListedAgentDefinition> {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  // This is the authoritative name and precedence resolver for both listing
  // and loading. Definitions are keyed by parsed frontmatter name (falling
  // back to the filename only when name is absent), with project > global >
  // package precedence. Sorting makes duplicate names within one source
  // deterministic as well.
  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md")).sort()) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, {
        ...parsed,
        source,
        ...(parsed.cli === "claude"
          ? { deprecated: true as const, deprecation: LEGACY_CLAUDE_DEPRECATION }
          : {}),
      });
    }
  }
  return agents;
}

export function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const all = [...resolveAgentDefinitionsByName().values()];
  // A restricted child may only discover its pinned names. This filtering is
  // shared by listing and model-invocation resolution rather than being
  // reimplemented by the launch path.
  return SUBAGENT_ALLOWLIST ? all.filter((a) => SUBAGENT_ALLOWLIST.has(a.name)) : all;
}

/** Definitions that a model is permitted to name in a `subagent` tool call. */
export function discoverModelInvocableAgentDefinitions(): ListedAgentDefinition[] {
  return discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);
}

/** Resolve a model-invocable definition using the exact listing resolver. */
export function loadModelInvocableAgent(agentName: string): ListedAgentDefinition | null {
  return discoverModelInvocableAgentDefinitions().find((agent) => agent.name === agentName) ?? null;
}

function isAbsoluteSubagentPath(path: string): boolean {
  // node:path follows the host platform. Also recognize Windows drive-letter
  // and UNC paths when tests or orchestration run through a POSIX shell.
  return isAbsolute(path) || win32.isAbsolute(path);
}

export function resolveSubagentPaths(
  params: AgentConfigurationParams,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? isAbsoluteSubagentPath(rawCwd)
      ? rawCwd
      : resolve(cwdBase, rawCwd)
    : null;

  // A child working directory may happen to contain `.pi/agent` (notably a
  // dotfiles checkout that backs up the global Pi directory). That does not
  // make it a replacement PI_CODING_AGENT_DIR. Keep auth, trust, packages, and
  // global roles rooted in the parent's real config directory; Pi discovers
  // project-local resources from `<cwd>/.pi` independently.
  return { effectiveCwd, effectiveAgentDir: getAgentConfigDir() };
}

export function resolveEffectiveModel(
  params: AgentConfigurationParams,
  agentDefs: AgentDefaults | null,
  parentModel?: { provider?: string; id?: string } | null,
): string | undefined {
  if (params.model) return params.model;
  if (agentDefs?.model) return agentDefs.model;
  if (parentModel?.provider && parentModel.id) {
    return `${parentModel.provider}/${parentModel.id}`;
  }
  return undefined;
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  _params: AgentConfigurationParams,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

export function resolveLaunchBehavior(
  params: AgentConfigurationParams,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
export function resolveEffectiveInteractive(
  _params: AgentConfigurationParams,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

interface LegacyClaudeWarningContext {
  sessionManager: object;
  ui: { notify(message: string, type: "warning"): void };
}

function legacyClaudeWarningSet(sessionManager: object): Set<string> {
  const globalState = globalThis as any;
  const warnings: WeakMap<object, Set<string>> = globalState[LEGACY_CLAUDE_WARNINGS_KEY] ??=
    new WeakMap<object, Set<string>>();
  let roles = warnings.get(sessionManager);
  if (!roles) {
    roles = new Set<string>();
    warnings.set(sessionManager, roles);
  }
  return roles;
}

export function warnLegacyClaudeRoleOnce(
  roleName: string,
  agent: AgentDefaults | null,
  ctx: LegacyClaudeWarningContext,
): boolean {
  if (agent?.cli !== "claude") return false;
  const warned = legacyClaudeWarningSet(ctx.sessionManager);
  if (warned.has(roleName)) return false;
  ctx.ui.notify(`Role "${roleName}" uses deprecated ${LEGACY_CLAUDE_DEPRECATION}`, "warning");
  warned.add(roleName);
  return true;
}

/**
 * Direct definition loading intentionally includes disable-model-invocation
 * roles (for trusted user/extension workflows), but uses the same canonical
 * frontmatter-name and source-precedence resolver as discovery.
 */
export function loadAgentDefaults(agentName: string): AgentDefaults | null {
  return resolveAgentDefinitionsByName().get(agentName) ?? null;
}
