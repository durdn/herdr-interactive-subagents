// hs - Herdr subagents for a Claude Code orchestrator.
//
// Places one Claude Code child per background tab in the orchestrator's Herdr
// workspace. Deliberately does NOT implement messaging, watching, or a name
// service: Claude Code's own SendMessage/ListAgents and Herdr's agent lifecycle
// already provide those. See docs/claude-orchestrator.md.
//
//   node scripts/hs.mjs spawn --role scout [--name n] [--cwd p] [--model m]
//   node scripts/hs.mjs list [--json]
//   node scripts/hs.mjs result <name> [--lines N]
//   node scripts/hs.mjs resume <name>
//   node scripts/hs.mjs stop <name> | stop-all
//   node scripts/hs.mjs roles
//   node scripts/hs.mjs doctor

import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <plugin>/scripts/hs.mjs, so the plugin root is one up.
const PLUGIN_DIR = resolve(
  process.env.CLAUDE_PLUGIN_ROOT || fileURLToPath(new URL("..", import.meta.url)),
);
const ROLE_DIRS = [
  join(process.cwd(), ".claude", "agents"),
  join(homedir(), ".claude", "agents"),
  join(PLUGIN_DIR, "agents"),
];
// A new pane is not an available shell until its shell reaches the prompt, and
// Herdr rejects `agent start` with agent_pane_busy until it is. These bound the
// retry in startAgentInPane; they are not a guess at how long that takes.
const SHELL_READY_MS = Number(process.env.HS_SHELL_READY_DELAY_MS || 600);
const SHELL_READY_TIMEOUT_MS = Number(process.env.HS_SHELL_READY_TIMEOUT_MS || 30000);
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// -- shell out -------------------------------------------------------------

function herdrBin() {
  return process.env.HERDR_BIN_PATH?.trim() || "herdr";
}

function herdr(args, { allowFailure = false } = {}) {
  const r = spawnSync(herdrBin(), args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFailure) {
    die(`herdr ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim() || `exit ${r.status}`}`);
  }
  return r;
}

function herdrJson(args, opts) {
  const r = herdr(args, opts);
  // Server errors are JSON on stderr with exit status 1.
  const out = ((r.stdout || "").trim() || (r.stderr || "").trim());
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    die(`unexpected herdr response for '${args.join(" ")}': ${out.slice(0, 400)}`);
  }
}

function die(message) {
  console.error(`hs: ${message}`);
  process.exit(1);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Start a child in a pane that may still be booting its shell. A fixed sleep
// loses this race on a loaded box - a fresh pane here needs seconds, not the
// 600ms it used to wait - so ask Herdr rather than guess: retry for as long as
// it says the pane is busy, and hand any other outcome back to the caller to
// report. agent_not_ready is NOT retried; that child started and is blocked.
function startAgentInPane(name, paneId, agentArgs) {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  for (;;) {
    sleepSync(SHELL_READY_MS);
    const started = herdrJson(
      ["agent", "start", name, "--kind", "claude", "--pane", paneId, "--timeout", "60000",
        "--", ...agentArgs],
      { allowFailure: true },
    );
    if (started?.result?.agent) return started;
    if (started?.error?.code !== "agent_pane_busy" || Date.now() >= deadline) return started;
  }
}

// -- context ---------------------------------------------------------------

function requireHerdr() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
    die("not running inside a Herdr pane (HERDR_ENV/HERDR_WORKSPACE_ID unset)");
  }
}

/** The workspace of the calling pane, not whichever one a UI client focuses. */
function callerWorkspace() {
  const res = herdrJson(["pane", "current", "--current"], { allowFailure: true });
  return res?.result?.pane?.workspace_id || process.env.HERDR_WORKSPACE_ID;
}

/**
 * Claude Code shows a blocking trust dialog the first time a session starts in
 * an unknown directory, which strands the child at startup. Refuse to spawn
 * there instead, and tell the user how to grant it once.
 */
function isTrustedCwd(cwd) {
  const configPath = join(homedir(), ".claude.json");
  if (!existsSync(configPath)) return true;
  let projects;
  try {
    projects = JSON.parse(readFileSync(configPath, "utf8"))?.projects || {};
  } catch {
    return true;
  }
  const norm = (p) => resolve(p).split("\\").join("/").replace(/\/+$/, "").toLowerCase();
  const want = norm(cwd);
  for (const [key, value] of Object.entries(projects)) {
    if (norm(key) === want) return value?.hasTrustDialogAccepted === true;
  }
  return false;
}

function parentSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || "unknown-parent";
}

// -- registry --------------------------------------------------------------
// Only records what Herdr cannot: which children THIS orchestrator owns, and
// with which role. Live state is always read back from Herdr.

function registryPath() {
  return join(homedir(), ".claude", "herdr-subagents", parentSessionId(), "registry.json");
}

function readRegistry() {
  const p = registryPath();
  if (!existsSync(p)) return { children: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed?.children) ? parsed : { children: [] };
  } catch {
    return { children: [] };
  }
}

function writeRegistry(reg) {
  const p = registryPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(reg, null, 2));
}

function upsertChild(entry) {
  const reg = readRegistry();
  reg.children = reg.children.filter((c) => c.name !== entry.name).concat(entry);
  writeRegistry(reg);
}

/**
 * Stopping closes the tab but not the Claude session, which stays resumable by
 * its id. Keep the entry and mark it, or `resume` would have nothing to replay.
 */
function markStopped(name) {
  const reg = readRegistry();
  const entry = reg.children.find((c) => c.name === name) || null;
  if (entry) {
    entry.stoppedAt = new Date().toISOString();
    writeRegistry(reg);
  }
  return entry;
}

function forgetChild(name) {
  const reg = readRegistry();
  const before = reg.children.length;
  reg.children = reg.children.filter((c) => c.name !== name);
  writeRegistry(reg);
  return reg.children.length < before;
}

// -- roles -----------------------------------------------------------------

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { fields, body: m[2].trim() };
}

function discoverRoles() {
  const roles = new Map();
  // Later directories must not shadow earlier ones: project > user > bundled.
  for (const dir of ROLE_DIRS) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const parsed = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
      if (!parsed) continue;
      const name = parsed.fields.name || basename(file, ".md");
      if (roles.has(name)) continue;
      roles.set(name, { name, dir, file: join(dir, file), ...parsed.fields });
    }
  }
  return roles;
}

function requireRole(name) {
  const roles = discoverRoles();
  const role = roles.get(name);
  if (!role) {
    die(`unknown role '${name}'. Known roles: ${[...roles.keys()].join(", ") || "(none)"}`);
  }
  return role;
}

// -- naming ----------------------------------------------------------------

function sanitizeName(raw) {
  let n = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!/^[a-z]/.test(n)) n = `a${n}`.slice(0, 32);
  return n.replace(/-+$/, "") || "child";
}

function liveAgentNames() {
  const res = herdrJson(["agent", "list"], { allowFailure: true });
  return new Set((res?.result?.agents || []).map((a) => a.name).filter(Boolean));
}

function uniqueName(base) {
  const taken = liveAgentNames();
  for (const c of readRegistry().children) taken.add(c.name);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 29)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  die(`could not find a free name based on '${base}'`);
}

// -- transcripts -----------------------------------------------------------

/** Claude Code writes <cwd-slug>/<session-id>.jsonl; search rather than derive. */
function transcriptPath(sessionId) {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const candidate = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function lastAssistantMessage(sessionId) {
  const path = transcriptPath(sessionId);
  if (!path) return null;
  let last = null;
  let sent = null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "assistant") continue;
    const blocks = entry?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        last = b.text.trim();
      } else if (b.type === "tool_use" && b.name === "SendMessage"
        && typeof b.input?.message === "string" && b.input.message.trim()) {
        sent = b.input.message.trim();
      }
    }
  }
  // A child that follows its role reports by calling SendMessage, so that call's
  // argument is the result - not whatever it printed afterwards.
  return sent ?? last;
}

// -- commands --------------------------------------------------------------

function extraDirs(opts, role) {
  const raw = [].concat(opts.addDir || [], (role["add-dir"] || "").split(",")).filter(
    (d) => typeof d === "string" && d.trim(),
  );
  return raw.map((d) => resolve(d.trim()));
}

function cmdSpawn(opts) {
  requireHerdr();
  if (!opts.role) die("spawn needs --role <name> (see: hs.mjs roles)");
  const role = requireRole(opts.role);

  // A bare role name collides with same-role children on other machines, which
  // Claude Code surfaces as an ambiguous SendMessage target. Suffix by default.
  const base = opts.name
    ? sanitizeName(opts.name)
    : `${sanitizeName(role.name).slice(0, 24)}-${crypto.randomUUID().slice(0, 4)}`;
  const name = uniqueName(base);
  if (!NAME_RE.test(name)) die(`derived name '${name}' is not a valid Herdr agent name`);

  const cwd = resolve(opts.cwd || role.cwd || process.cwd());
  if (!existsSync(cwd)) die(`cwd does not exist: ${cwd}`);
  if (!isTrustedCwd(cwd)) {
    die([
      `${cwd} has not been trusted for Claude Code, so a child would stall on the trust dialog.`,
      "    Either spawn with --cwd set to a directory you already work in and pass",
      `    --add-dir ${cwd}, or run 'claude' there once yourself and accept the prompt.`,
    ].join("\n"));
  }

  const workspace = callerWorkspace();
  const created = herdrJson([
    "tab", "create",
    "--workspace", workspace,
    "--cwd", cwd,
    "--label", name,
    "--no-focus",
  ]);
  const tabId = created?.result?.tab?.tab_id;
  const paneId = created?.result?.root_pane?.pane_id;
  if (!paneId) die(`Herdr did not return a root pane: ${JSON.stringify(created)}`);

  const sessionId = crypto.randomUUID();
  const model = opts.model || role.model || null;
  // A child is an ordinary session, not a teammate: it does not inherit the
  // orchestrator's model or effort, it resolves its own from its settings and
  // the model default. State both per role so a scout is never billed like a
  // reviewer, and record them in argv so `resume` replays the same loadout.
  const effort = opts.effort || role.effort || null;
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    die(`unknown effort '${effort}' (low, medium, high, xhigh, max)`);
  }
  const childArgs = [
    "--name", name,
    "--session-id", sessionId,
    // auto, not acceptEdits: acceptEdits still stops the child dead on every Bash
    // and WebFetch approval, and a background tab nobody is watching just sits
    // there. bypassPermissions is NOT the alternative - a child in that class has
    // every message it sends held for the user's approval, which breaks reporting.
    "--permission-mode", opts.permissionMode || role["permission-mode"] || "auto",
    // The role carries the identity, the tool allowlist, and the reply contract,
    // so nothing long or quoted has to survive the pane's shell.
    "--agent", role.name,
    "--plugin-dir", PLUGIN_DIR,
    "--settings", '{"crossSessionInbound":"accept"}',
  ];
  if (model) childArgs.push("--model", model);
  if (effort) childArgs.push("--effort", effort);
  // Anything outside cwd that the child may legitimately read; without this it
  // blocks on an approval prompt the orchestrator must not answer for the user.
  for (const dir of extraDirs(opts, role)) childArgs.push("--add-dir", dir);

  const started = startAgentInPane(name, paneId, childArgs);
  const agent = started?.result?.agent;
  if (!agent) {
    // Herdr keeps the name readable after agent_not_ready; capture the screen
    // before the tab goes, so the reason survives.
    const screen = herdr(["agent", "read", name, "--source", "detection", "--lines", "30"], {
      allowFailure: true,
    }).stdout || "";
    herdr(["tab", "close", tabId], { allowFailure: true });
    die([
      `could not start '${name}'; tab ${tabId} closed.`,
      `    ${started?.error?.message || JSON.stringify(started)}`,
      ...screen.split(/\r?\n/).filter(Boolean).slice(-12).map((l) => `    | ${l}`),
    ].join("\n"));
  }

  const entry = {
    name,
    sessionId,
    role: role.name,
    cwd,
    tabId,
    paneId,
    workspace,
    model,
    effort,
    parent: parentSessionId(),
    startedAt: new Date().toISOString(),
    argv: childArgs,
  };
  upsertChild(entry);

  console.log(JSON.stringify({
    ...entry,
    status: agent.agent_status,
    next: `Send the task with SendMessage to "${name}" (add notify_when_idle: true).`,
  }, null, 2));
}

function cmdList(opts) {
  const reg = readRegistry();
  const live = new Map();
  const res = herdrJson(["agent", "list"], { allowFailure: true });
  for (const a of res?.result?.agents || []) if (a.name) live.set(a.name, a);

  const rows = reg.children.map((c) => ({
    name: c.name,
    role: c.role,
    status: live.get(c.name)?.agent_status || (c.stoppedAt ? "stopped" : "gone"),
    tab: c.tabId,
    cwd: c.cwd,
    sessionId: c.sessionId,
    startedAt: c.startedAt,
  }));

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log("no subagents owned by this session");
    return;
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad("NAME", 20)}${pad("ROLE", 14)}${pad("STATUS", 10)}${pad("TAB", 10)}CWD`);
  for (const r of rows) {
    console.log(`${pad(r.name, 20)}${pad(r.role, 14)}${pad(r.status, 10)}${pad(r.tab, 10)}${r.cwd}`);
  }
}

function cmdResult(name, opts) {
  const entry = readRegistry().children.find((c) => c.name === name);
  const sessionId = entry?.sessionId
    || herdrJson(["agent", "get", name], { allowFailure: true })?.result?.agent?.agent_session?.value;
  if (!sessionId) die(`no session id known for '${name}'`);
  const text = lastAssistantMessage(sessionId);
  if (text === null) {
    die(`no transcript found for '${name}' (session ${sessionId})`);
  }
  const lines = Number(opts.lines || 0);
  console.log(lines > 0 ? text.split(/\r?\n/).slice(-lines).join("\n") : text);
}

function cmdResume(name) {
  requireHerdr();
  const entry = readRegistry().children.find((c) => c.name === name);
  if (!entry) die(`'${name}' is not a subagent owned by this session`);
  if (liveAgentNames().has(name)) die(`'${name}' is still live; message it instead of resuming`);

  const created = herdrJson([
    "tab", "create",
    "--workspace", callerWorkspace(),
    "--cwd", entry.cwd,
    "--label", name,
    "--no-focus",
  ]);
  const tabId = created?.result?.tab?.tab_id;
  const paneId = created?.result?.root_pane?.pane_id;
  if (!paneId) die(`Herdr did not return a root pane: ${JSON.stringify(created)}`);

  // Replay the recorded loadout, swapping the fresh-session flag for a resume.
  const childArgs = entry.argv.filter((a, i, all) => {
    if (a === "--session-id") return false;
    return all[i - 1] !== "--session-id";
  });
  const started = startAgentInPane(name, paneId, ["--resume", entry.sessionId, ...childArgs]);
  if (!started?.result?.agent) {
    herdr(["tab", "close", tabId], { allowFailure: true });
    die(`could not resume '${name}'. Response: ${JSON.stringify(started)}`);
  }
  const { stoppedAt, ...revived } = entry;
  upsertChild({ ...revived, tabId, paneId, resumedAt: new Date().toISOString() });
  console.log(JSON.stringify({ name, sessionId: entry.sessionId, tabId, paneId, status: "resumed" }, null, 2));
}

function cmdStop(name) {
  const entry = markStopped(name);
  if (!entry) die(`'${name}' is not a subagent owned by this session (refusing to close a tab we did not create)`);
  const tabId = entry.tabId
    || herdrJson(["agent", "get", name], { allowFailure: true })?.result?.agent?.tab_id;
  if (tabId) herdr(["tab", "close", tabId], { allowFailure: true });
  console.log(`stopped ${name}${tabId ? ` (closed ${tabId})` : " (tab already gone)"} - resumable`);
}

function cmdStopAll() {
  const names = readRegistry().children.filter((c) => !c.stoppedAt).map((c) => c.name);
  if (!names.length) {
    console.log("no running subagents owned by this session");
    return;
  }
  for (const name of names) cmdStop(name);
}

function cmdForget(name) {
  if (liveAgentNames().has(name)) die(`'${name}' is still live; stop it first`);
  console.log(forgetChild(name) ? `forgot ${name}` : `'${name}' was not in this session's registry`);
}

function cmdRoles() {
  const roles = [...discoverRoles().values()];
  if (!roles.length) {
    console.log("no roles found");
    return;
  }
  const pad = (s, n) => String(s ?? "-").padEnd(n);
  console.log(`${pad("ROLE", 14)}${pad("MODEL", 10)}${pad("EFFORT", 8)}DESCRIPTION`);
  for (const r of roles) {
    console.log(`${pad(r.name, 14)}${pad(r.model, 10)}${pad(r.effort, 8)}${r.description || ""}`);
  }
}

/**
 * A plugin directory under ~/.claude/skills/<name> auto-loads for every session
 * as <name>@skills-dir, so a link there is the whole install.
 */
function installLink() {
  return join(homedir(), ".claude", "skills", "herdr-subagents");
}

function linkTarget(path) {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(readlinkSync(path)) : null;
  } catch {
    return null;
  }
}

function cmdInstall() {
  const link = installLink();
  if (existsSync(link) || linkTarget(link)) {
    const target = linkTarget(link);
    if (target === PLUGIN_DIR) {
      console.log(`already installed: ${link} -> ${target}`);
      return;
    }
    die(`${link} already exists${target ? ` (points at ${target})` : ""}; remove it first`);
  }
  mkdirSync(join(link, ".."), { recursive: true });
  // "junction" is the only link type Windows grants without elevation.
  symlinkSync(PLUGIN_DIR, link, process.platform === "win32" ? "junction" : "dir");
  console.log(`installed: ${link} -> ${PLUGIN_DIR}`);
  console.log("Restart Claude Code to pick up the skill and commands.");
}

function cmdUninstall() {
  const link = installLink();
  if (!existsSync(link) && !linkTarget(link)) {
    console.log("not installed");
    return;
  }
  if (!linkTarget(link) && !lstatSync(link).isDirectory()) die(`${link} is not a link we created`);
  rmSync(link, { recursive: false, force: true });
  console.log(`removed ${link}`);
}

function cmdDoctor() {
  let failed = false;
  const check = (ok, message) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${message}`);
    failed ||= !ok;
  };

  check(process.env.HERDR_ENV === "1", "running inside a Herdr pane");
  check(Boolean(process.env.HERDR_WORKSPACE_ID), `workspace context (${process.env.HERDR_WORKSPACE_ID || "unset"})`);

  const hv = herdr(["--version"], { allowFailure: true });
  check(hv.status === 0, `Herdr CLI callable (${(hv.stdout || "").trim() || "no output"})`);

  const cv = spawnSync("claude", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  const version = (cv.stdout || "").trim();
  const num = version.match(/(\d+)\.(\d+)\.(\d+)/);
  const atLeast = (a, b, c) =>
    num && (Number(num[1]) > a
      || (Number(num[1]) === a && (Number(num[2]) > b || (Number(num[2]) === b && Number(num[3]) >= c))));
  check(cv.status === 0, `claude CLI callable (${version || "no output"})`);
  const winMin = process.platform === "win32" ? atLeast(2, 1, 234) : atLeast(2, 1, 224);
  check(Boolean(winMin), "claude supports cross-session messaging");
  check(Boolean(atLeast(2, 1, 236)), "claude supports notify_when_idle completion notices");

  check(Boolean(process.env.CLAUDE_CODE_MESSAGING_SOCKET), "this session binds a messaging inbox");
  check(existsSync(PLUGIN_DIR), `plugin directory present (${PLUGIN_DIR})`);
  const linked = linkTarget(installLink()) === PLUGIN_DIR;
  console.log(
    `${linked ? "ok  " : "note"}  ${linked
      ? `installed at ${installLink()}`
      : "not installed for the orchestrator (run: hs.mjs install) - spawning still works"}`,
  );
  const roles = discoverRoles();
  check(roles.size > 0, `roles discovered (${[...roles.keys()].join(", ") || "none"})`);

  try {
    writeRegistry(readRegistry());
    check(true, `registry writable (${registryPath()})`);
  } catch (e) {
    check(false, `registry not writable: ${e.message}`);
  }

  process.exit(failed ? 1 : 0);
}

// -- argv ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith("--") ? true : argv[++i];
      // A repeated flag (--add-dir a --add-dir b) collects instead of overwriting.
      if (key in opts) opts[key] = [].concat(opts[key], value);
      else opts[key] = value;
    } else positional.push(a);
  }
  return { opts, positional };
}

const [command, ...rest] = process.argv.slice(2);
const { opts, positional } = parseArgs(rest);

switch (command) {
  case "spawn": cmdSpawn(opts); break;
  case "list": cmdList(opts); break;
  case "result": cmdResult(positional[0] || die("result needs a name"), opts); break;
  case "resume": cmdResume(positional[0] || die("resume needs a name")); break;
  case "stop": cmdStop(positional[0] || die("stop needs a name")); break;
  case "stop-all": cmdStopAll(); break;
  case "forget": cmdForget(positional[0] || die("forget needs a name")); break;
  case "roles": cmdRoles(); break;
  case "install": cmdInstall(); break;
  case "uninstall": cmdUninstall(); break;
  case "doctor": cmdDoctor(); break;
  default:
    console.error(
      "usage: hs.mjs spawn|list|result|resume|stop|stop-all|forget|roles|install|uninstall|doctor",
    );
    process.exit(2);
}
