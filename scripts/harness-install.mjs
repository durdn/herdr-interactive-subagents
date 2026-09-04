#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY_ROOT = resolve(
  process.env.HERDR_PLUGIN_ROOT || fileURLToPath(new URL("..", import.meta.url)),
);

const HARNESSES = ["pi", "claude", "codex"];
const ACTIONS = ["install", "uninstall", "doctor"];

function out(message) {
  console.log(message);
}

function normalizePath(path) {
  let normalized = resolve(path).replace(/^\\\\\?\\/, "");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/, "");
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function linkTarget(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

export function codexSkillSource(root = REPOSITORY_ROOT) {
  return join(root, "skills", "herdr-subagents");
}

/**
 * Codex's current user-wide standalone-skill location is ~/.agents/skills.
 * The explicit override is useful for managed profiles and deterministic tests.
 */
export function codexSkillTarget({
  home = homedir(),
  env = process.env,
} = {}) {
  const parent = env.HERDR_CODEX_SKILLS_DIR
    ? resolve(env.HERDR_CODEX_SKILLS_DIR)
    : join(home, ".agents", "skills");
  return join(parent, "herdr-subagents");
}

export function inspectCodexInstall(options = {}) {
  const source = codexSkillSource(options.root);
  const target = codexSkillTarget(options);
  const linked = linkTarget(target);
  const launcher = join(source, "scripts", "codex-subagents.mjs");
  const sourceValid = existsSync(join(source, "SKILL.md")) && existsSync(launcher);
  return {
    source,
    target,
    launcher,
    linked,
    sourceValid,
    installed: sourceValid && Boolean(linked) && samePath(linked, source),
    targetExists: pathEntryExists(target),
  };
}

export function installCodex(options = {}) {
  const state = inspectCodexInstall(options);
  if (!state.sourceValid) {
    throw new Error(`no Codex skill found at ${state.source}`);
  }
  if (state.installed) {
    out(`already installed: ${state.target} -> ${state.source}`);
    return state;
  }
  if (state.targetExists) {
    const detail = state.linked ? ` (points at ${state.linked})` : "";
    throw new Error(`${state.target} already exists${detail}; refusing to overwrite it`);
  }

  mkdirSync(dirname(state.target), { recursive: true });
  symlinkSync(
    state.source,
    state.target,
    process.platform === "win32" ? "junction" : "dir",
  );
  out(`installed: ${state.target} -> ${state.source}`);
  out("Start a new Codex session to refresh the global skill list.");
  return inspectCodexInstall(options);
}

export function uninstallCodex(options = {}) {
  const state = inspectCodexInstall(options);
  if (!state.targetExists) {
    out(`not installed: ${state.target}`);
    return state;
  }
  if (!state.installed) {
    const detail = state.linked ? `; points at ${state.linked}` : "";
    throw new Error(`${state.target} is not owned by this checkout${detail}; refusing to remove it`);
  }

  rmSync(state.target, { recursive: false, force: true });
  out(`removed: ${state.target}`);
  return inspectCodexInstall(options);
}

function commandResult(bin, args, { capture = false, allowFailure = false } = {}) {
  // Node cannot directly execute the Windows command shims installed by npm.
  const useCmd = process.platform === "win32" && bin === "pi";
  const result = spawnSync(
    useCmd ? "cmd.exe" : bin,
    useCmd ? ["/d", "/c", "pi.cmd", ...args] : args,
    {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    },
  );
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} exited with status ${result.status ?? 1}`);
  }
  return result;
}

function piConfigDir({ home = homedir(), env = process.env } = {}) {
  return resolve(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"));
}

export function installedPiSources(options = {}) {
  const configDir = piConfigDir(options);
  const settingsPath = join(configDir, "settings.json");
  if (!existsSync(settingsPath)) return [];
  let settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${settingsPath}: ${error.message}`);
  }
  if (!Array.isArray(settings.packages)) return [];
  return settings.packages
    .filter((source) => typeof source === "string")
    .map((source) => ({ source, resolved: resolve(configDir, source) }));
}

function piInstalled(options = {}) {
  const root = resolve(options.root || REPOSITORY_ROOT);
  return installedPiSources(options).some(({ resolved }) => samePath(resolved, root));
}

function runPi(action, options = {}) {
  const root = resolve(options.root || REPOSITORY_ROOT);
  if (action === "install") {
    if (piInstalled(options)) {
      out(`already installed: pi package ${root}`);
      return;
    }
    commandResult("pi", ["install", root]);
    out("Restart pi or run /reload to pick up the package.");
    return;
  }
  if (action === "uninstall") {
    if (!piInstalled(options)) {
      out(`not installed: pi package ${root}`);
      return;
    }
    commandResult("pi", ["remove", root]);
    return;
  }

  const installed = piInstalled(options);
  out(`${installed ? "ok  " : "FAIL"}  pi package ${installed ? "installed from" : "not installed from"} ${root}`);
  if (!installed) throw new Error("pi installation check failed");
}

function runClaude(action, options = {}) {
  const root = resolve(options.root || REPOSITORY_ROOT);
  const script = join(root, "claude-plugin", "scripts", "hs.mjs");
  if (!existsSync(script)) throw new Error(`Claude installer missing at ${script}`);
  const command = action === "uninstall" ? "uninstall" : action;
  commandResult(process.execPath, [script, command]);
}

function runCodex(action, options = {}) {
  if (action === "install") return installCodex(options);
  if (action === "uninstall") return uninstallCodex(options);

  const state = inspectCodexInstall(options);
  out(`${state.sourceValid ? "ok  " : "FAIL"}  Codex skill source ${state.source}`);
  out(`${existsSync(state.launcher) ? "ok  " : "FAIL"}  Codex Herdr launcher ${state.launcher}`);
  out(`${state.installed ? "ok  " : "FAIL"}  Codex user skill ${state.target}`);
  if (!state.sourceValid || !state.installed) throw new Error("Codex installation check failed");
}

export function runHarness(action, harness, options = {}) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown action: ${action}`);
  if (![...HARNESSES, "all"].includes(harness)) throw new Error(`unknown harness: ${harness}`);

  const selected = harness === "all" ? HARNESSES : [harness];
  for (const name of selected) {
    out(`\n[${name}] ${action}`);
    if (name === "pi") runPi(action, options);
    else if (name === "claude") runClaude(action, options);
    else runCodex(action, options);
  }
}

function usage() {
  return [
    "usage: node scripts/harness-install.mjs <install|uninstall|doctor> <pi|claude|codex|all>",
    "",
    "Examples:",
    "  npm run harness:install -- codex",
    "  npm run harness:doctor -- all",
    "  npm run harness:uninstall -- claude",
    "",
    "This local-development installer never creates or publishes a marketplace.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const [action, harness, ...rest] = argv;
  if (rest.length || !ACTIONS.includes(action) || ![...HARNESSES, "all"].includes(harness)) {
    console.error(usage());
    return 2;
  }
  try {
    runHarness(action, harness);
    return 0;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
