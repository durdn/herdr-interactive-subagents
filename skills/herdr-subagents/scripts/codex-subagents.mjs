#!/usr/bin/env node

// Codex does not expose its native subagent mailbox across independent CLI
// processes. This launcher deliberately uses Herdr as that boundary instead:
// Herdr owns visible tabs and lifecycle, while this file owns the small amount
// of parent-scoped identity, permission propagation, and transcript retrieval
// needed to make those sessions useful to an orchestrating Codex process.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REFERENCES_DIR = join(SKILL_DIR, "references");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const START_TIMEOUT_MS = validTimeout(process.env.HCS_AGENT_START_TIMEOUT_MS, 90_000);
const PROMPT_START_TIMEOUT_MS = positiveNumber(process.env.HCS_PROMPT_START_TIMEOUT_MS, 30_000);
const SHELL_READY_DELAY_MS = positiveNumber(process.env.HCS_SHELL_READY_DELAY_MS, 600);
const SHELL_READY_TIMEOUT_MS = positiveNumber(process.env.HCS_SHELL_READY_TIMEOUT_MS, 30_000);
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const RESULT_SETTLE_MS = 1_500;
// Herdr's settled states. A finished tab the user has looked at reads idle, not done.
const SETTLED_STATES = ["--until", "idle", "--until", "done", "--until", "blocked"];
const PROMPT_START_STATES = ["--until", "working", "--until", "done", "--until", "blocked"];

class HcsError extends Error {}

function die(message) {
  throw new HcsError(message);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : fallback;
}

function validTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 3_000 && number <= 300_000
    ? Math.round(number)
    : fallback;
}

function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    const value = next === undefined || next.startsWith("--") ? true : argv[++index];
    if (key in opts) opts[key] = [].concat(opts[key], value);
    else opts[key] = value;
  }
  return { opts, positional };
}

function herdrCommand() {
  const configured = process.env.HERDR_BIN_PATH?.trim();
  if (configured?.endsWith(".mjs")) return [process.execPath, configured];
  return [configured || "herdr"];
}

function runHerdr(args, { allowFailure = false } = {}) {
  const [command, ...prefix] = herdrCommand();
  const result = spawnSync(command, [...prefix, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim() || `exit ${result.status}`;
    die(`herdr ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

function herdrJson(args, options) {
  const result = runHerdr(args, options);
  const output = (result.stdout || "").trim() || (result.stderr || "").trim();
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    die(`unexpected herdr response for '${args.join(" ")}': ${output.slice(0, 500)}`);
  }
}

function requireHerdr() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
    die("not running inside Herdr (HERDR_ENV/HERDR_WORKSPACE_ID are required)");
  }
}

function currentPane() {
  const result = herdrJson(["pane", "current", "--current"], { allowFailure: true });
  return result?.result?.pane || null;
}

function callerWorkspace() {
  return currentPane()?.workspace_id || process.env.HERDR_WORKSPACE_ID;
}

function parentSessionId() {
  const raw = process.env.CODEX_SESSION_ID
    || process.env.CODEX_THREAD_ID
    || process.env.HERDR_PANE_ID
    || "unknown-parent";
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

function registryRoot() {
  return process.env.HCS_REGISTRY_ROOT
    ? resolve(process.env.HCS_REGISTRY_ROOT)
    : join(tmpdir(), "herdr-interactive-subagents", "codex");
}

function registryPath() {
  return join(registryRoot(), parentSessionId(), "registry.json");
}

function readRegistry({ strict = false } = {}) {
  const path = registryPath();
  if (!existsSync(path)) return { version: 1, children: [] };
  try {
    const registry = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(registry?.children)) throw new Error("missing children array");
    return registry;
  } catch (error) {
    if (strict) die(`registry is corrupt at ${path}: ${error.message}`);
    return { version: 1, children: [] };
  }
}

function acquireRegistryLock() {
  const path = registryPath() + ".lock";
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      const token = `${process.pid}:${randomUUID()}`;
      writeFileSync(fd, token);
      return { fd, path, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (statSync(path).mtimeMs + LOCK_STALE_MS < Date.now()) unlinkSync(path);
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      if (Date.now() >= deadline) die(`timed out acquiring registry lock ${path}`);
      sleepSync(10);
    }
  }
}

function releaseRegistryLock(lock) {
  try { closeSync(lock.fd); } catch { /* already closed */ }
  try {
    if (readFileSync(lock.path, "utf8") === lock.token) unlinkSync(lock.path);
  } catch { /* another process recovered a stale lock */ }
}

function withRegistryLock(callback) {
  const lock = acquireRegistryLock();
  try { return callback(); }
  finally { releaseRegistryLock(lock); }
}

function writeRegistryUnlocked(registry) {
  const path = registryPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(registry, null, 2));
  try { renameSync(temporary, path); }
  catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function updateRegistry(callback) {
  return withRegistryLock(() => {
    const registry = readRegistry({ strict: true });
    const result = callback(registry);
    writeRegistryUnlocked(registry);
    return result;
  });
}

function upsertChild(entry) {
  updateRegistry((registry) => {
    registry.children = registry.children.filter((child) => child.name !== entry.name);
    registry.children.push(entry);
  });
}

function requireOwned(name) {
  const entry = readRegistry({ strict: true }).children.find((child) => child.name === name);
  if (!entry) die(`'${name}' is not a Codex child owned by this parent session`);
  return entry;
}

function parseFrontmatter(markdown) {
  const normalized = markdown.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { attributes: {}, body: normalized.trim() };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { attributes: {}, body: normalized.trim() };
  const attributes = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (match) attributes[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return { attributes, body: normalized.slice(end + 5).trim() };
}

function roleNames() {
  try {
    return readdirSync(REFERENCES_DIR)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function loadRole(name) {
  if (!NAME_RE.test(name || "")) die("spawn needs a valid --role <name>");
  const path = join(REFERENCES_DIR, `${name}.md`);
  if (!existsSync(path)) die(`unknown role '${name}' (available: ${roleNames().join(", ") || "none"})`);
  const parsed = parseFrontmatter(readFileSync(path, "utf8"));
  return { name, path, ...parsed };
}

function taskText(opts) {
  if (opts.task === true || opts.taskFile === true) die("--task/--task-file need a value");
  if (opts.task && opts.taskFile) die("pass --task or --task-file, not both");
  if (opts.taskFile) {
    const path = resolve(opts.taskFile);
    if (!existsSync(path)) die(`--task-file does not exist: ${path}`);
    return readFileSync(path, "utf8").trim();
  }
  return [].concat(opts.task || []).filter((part) => typeof part === "string").join("\n").trim();
}

// A follow-up amends the assignment; it must not replace it. The child is told so, and
// told to name every brief its final answer closes.
function taskPrompt(role, task, brief) {
  if (brief.kind === "follow-up") {
    const all = [...brief.amends, brief.id].join(", ");
    return [
      `# Follow-up ${brief.id} to your assignment`,
      "",
      task,
      "",
      "# Session boundary",
      "",
      `Your assignment (${brief.amends.join(", ")}) stands; this follow-up amends it and closes nothing by itself.`,
      `Finish everything still open, then begin your final answer with a line \`Closes: ${all}\` naming`,
      "each brief it completes; a brief left unfinished stays off that line, with the reason in the answer.",
    ].join("\n");
  }
  return [
    "# Role contract",
    "",
    role.body,
    "",
    "# Assignment",
    "",
    task,
    "",
    "# Session boundary",
    "",
    "You are a visible Codex child running in a Herdr tab. You do not inherit the parent conversation.",
    "Your final assistant message is the complete result that the parent will retrieve from this session.",
    `Begin it with a line \`Closes: ${brief.id}\`. A follow-up you receive later names its own id; the assignment stands.`,
    "Do not delegate further unless the assignment explicitly authorizes nested delegation.",
  ].join("\n");
}

// A brief id is the message receipt: the child's transcript quotes the brief's file name
// when it reads it, and the final answer names the ids it closes.
function nextBrief(entry, kind) {
  const briefs = entry.briefs || [];
  return {
    id: `b${briefs.length + 1}`,
    kind,
    amends: kind === "follow-up" ? briefs.map((brief) => brief.id) : [],
    sentAt: new Date().toISOString(),
  };
}

function writeBrief(entry, role, task, brief) {
  const directory = join(dirname(registryPath()), "briefs");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${entry.name}-${brief.id}-${randomUUID()}.md`);
  writeFileSync(path, `${taskPrompt(role, task, brief)}\n`);
  return path;
}

function briefInstruction(brief, path) {
  const portable = path.replaceAll("\\", "/");
  if (brief.kind === "follow-up") {
    return `Read follow-up ${brief.id} at ${portable} and fold it into your current assignment, which stands.`;
  }
  return `Read the complete task brief at ${portable} and follow it. Return the requested deliverable as your final answer.`;
}

function budgetFields(opts, startedAt) {
  if (opts.budgetMin === undefined) return { budgetMin: null, deadline: null };
  const minutes = Number(opts.budgetMin);
  if (opts.budgetMin === true || !Number.isFinite(minutes) || minutes <= 0) {
    die("--budget-min needs a positive number of minutes");
  }
  return { budgetMin: minutes, deadline: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString() };
}

function normalizePermissionProfile(profile = process.env.CODEX_PERMISSION_PROFILE) {
  const value = String(profile || "").trim().toLowerCase();
  if ([":danger-full-access", "danger-full-access", "full", "yolo"].includes(value)) {
    return ":danger-full-access";
  }
  if ([":workspace", "workspace", "workspace-write"].includes(value)) return ":workspace";
  if ([":read-only", "read-only", "readonly"].includes(value)) return ":read-only";
  return String(profile || "").trim();
}

function codexPermissionArgs(profile = process.env.CODEX_PERMISSION_PROFILE) {
  const normalized = normalizePermissionProfile(profile);
  if (normalized === ":danger-full-access") {
    return {
      profile: normalized,
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      description: "YOLO mode (no sandbox and no approval prompts)",
    };
  }
  if (normalized === ":workspace") {
    return {
      profile: normalized,
      args: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
      description: "workspace-write with on-request approvals",
    };
  }
  if (normalized === ":read-only") {
    return {
      profile: normalized,
      args: ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
      description: "read-only with on-request approvals",
    };
  }
  if (normalized) {
    const escaped = normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    return {
      profile: normalized,
      args: ["-c", `default_permissions="${escaped}"`],
      description: `configured permission profile ${normalized}`,
    };
  }
  return {
    profile: null,
    args: [],
    description: "Codex configured default (parent live profile was unavailable)",
  };
}

function whereWindows(name) {
  const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
}

function packageNativeExecutables(wrapperDirectory) {
  const scope = join(wrapperDirectory, "node_modules", "@openai", "codex", "node_modules", "@openai");
  if (!existsSync(scope)) return [];
  const results = [];
  for (const packageName of readdirSync(scope)) {
    if (!packageName.startsWith("codex-win32-")) continue;
    const vendor = join(scope, packageName, "vendor");
    if (!existsSync(vendor)) continue;
    for (const target of readdirSync(vendor)) {
      for (const candidate of [
        join(vendor, target, "bin", "codex.exe"),
        join(vendor, target, "codex.exe"),
      ]) {
        if (existsSync(candidate)) results.push(candidate);
      }
    }
  }
  return results;
}

function resolveWindowsCodexExecutable() {
  if (process.platform !== "win32" || process.env.HCS_SKIP_WINDOWS_CODEX_EXE === "1") return null;
  const override = process.env.HERDR_CODEX_EXE?.trim();
  if (override) {
    const path = resolve(override);
    if (!existsSync(path) || basename(path).toLowerCase() !== "codex.exe") {
      die(`HERDR_CODEX_EXE must point to an existing codex.exe: ${path}`);
    }
    return path;
  }

  const direct = whereWindows("codex.exe").find((path) => existsSync(path));
  if (direct) return direct;

  const wrapperDirectories = new Set([
    ...whereWindows("codex.cmd"),
    ...whereWindows("codex.ps1"),
  ].map(dirname));
  for (const directory of wrapperDirectories) {
    const native = packageNativeExecutables(directory)[0];
    if (native) return native;
  }

  const sandboxProxy = join(homedir(), ".codex", ".sandbox-bin", "codex.exe");
  if (existsSync(sandboxProxy)) return sandboxProxy;
  die("Herdr needs a real codex.exe on Windows, but only a command shim was found. Reinstall @openai/codex or set HERDR_CODEX_EXE.");
}

function tabEnvironmentArgs() {
  const args = [];
  const executable = resolveWindowsCodexExecutable();
  if (executable) args.push("--env", `PATH=${dirname(executable)}${delimiter}${process.env.PATH || ""}`);
  return { args, executable };
}

// A resumed session keeps the model and reasoning it ran on; the role's defaults are for
// a fresh one. An explicit flag overrides either, and the caller reports the override.
function pickSetting(override, recorded, fallback) {
  if (override) return { value: override, source: "override" };
  if (recorded) return { value: recorded, source: "recorded" };
  return { value: fallback || null, source: "role" };
}

function codexLaunchArgs({ cwd, role, opts = {}, resumeSessionId = null, prior = null }) {
  const permission = codexPermissionArgs();
  if (opts.model === true) die("--model needs a value");
  if (opts.reasoning === true) die("--reasoning needs a value");
  const model = pickSetting(opts.model, prior?.model, role.attributes.model);
  const reasoning = pickSetting(opts.reasoning, prior?.reasoning, role.attributes.reasoning);
  const args = [...permission.args, "--no-alt-screen", "-C", cwd];
  if (model.value) args.push("--model", model.value);
  if (reasoning.value) args.push("-c", `model_reasoning_effort="${reasoning.value}"`);
  if (resumeSessionId) args.push("resume", resumeSessionId);
  return {
    args,
    model: model.value,
    reasoning: reasoning.value,
    modelSource: model.source,
    reasoningSource: reasoning.source,
    permission,
  };
}

function startAgentInPane(name, paneId, agentArgs, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  for (;;) {
    sleepSync(SHELL_READY_DELAY_MS);
    const started = herdrJson([
      "agent", "start", name, "--kind", "codex", "--pane", paneId,
      "--timeout", String(timeoutMs), "--", ...agentArgs,
    ], { allowFailure: true });
    if (started?.result?.agent) return started;
    if (started?.error?.code !== "agent_pane_busy" || Date.now() >= deadline) return started;
  }
}

function getAgent(target) {
  return herdrJson(["agent", "get", target], { allowFailure: true })?.result?.agent || null;
}

function confirmAgent(name, paneId) {
  return getAgent(name) || (paneId ? getAgent(paneId) : null);
}

function ensureNameFree(name) {
  if (!NAME_RE.test(name)) {
    die("--name must match ^[a-z][a-z0-9_-]{0,31}$");
  }
  const existing = readRegistry({ strict: true }).children.find((child) => child.name === name);
  if (existing && !existing.stoppedAt) die(`this parent already owns a running child named '${name}'`);
  if (getAgent(name)) die(`Herdr already has a live agent named '${name}'`);
}

function createChildTab(name, cwd, workspace) {
  const environment = tabEnvironmentArgs();
  const created = herdrJson([
    "tab", "create", "--workspace", workspace, "--cwd", cwd,
    "--label", name, ...environment.args, "--no-focus",
  ]);
  const tabId = created?.result?.tab?.tab_id;
  const paneId = created?.result?.root_pane?.pane_id;
  if (!tabId || !paneId) die("Herdr created a tab without returning its tab and pane ids");
  return { tabId, paneId, codexExecutable: environment.executable };
}

function startWatcher(name) {
  if (process.env.HCS_DISABLE_WATCHER === "1") return false;
  const child = spawn(process.execPath, [SCRIPT_PATH, "_watch", name], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  return true;
}

function spawnName(role, requested) {
  if (requested === true) die("--name needs a value");
  return requested || `${role}-${randomUUID().slice(0, 6)}`;
}

function launchChild({ name, role, cwd, opts, resumeSessionId = null, prior = null }) {
  requireHerdr();
  ensureNameFree(name);
  if (!existsSync(cwd) || !lstatSync(cwd).isDirectory()) die(`--cwd is not a directory: ${cwd}`);
  const workspace = callerWorkspace();
  const launch = codexLaunchArgs({ cwd, role, opts, resumeSessionId, prior });
  const startedAt = new Date().toISOString();
  const budget = budgetFields(opts, startedAt);
  const created = createChildTab(name, cwd, workspace);
  let entry = {
    ...(prior || {}),
    name,
    role: role.name,
    cwd,
    workspace,
    tabId: created.tabId,
    paneId: created.paneId,
    model: launch.model,
    reasoning: launch.reasoning,
    modelSource: launch.modelSource,
    reasoningSource: launch.reasoningSource,
    permissionProfile: launch.permission.profile,
    permissionDescription: launch.permission.description,
    codexExecutable: created.codexExecutable,
    startedAt,
    ...budget,
    stoppedAt: null,
    status: "starting",
  };
  upsertChild(entry);

  const timeout = opts.startupTimeout === undefined
    ? START_TIMEOUT_MS
    : validTimeout(opts.startupTimeout, null);
  if (timeout === null) die("--startup-timeout must be more than 3000 and at most 300000 ms");
  const started = startAgentInPane(name, created.paneId, launch.args, timeout);
  const agent = started?.result?.agent || confirmAgent(name, created.paneId);
  if (!agent) {
    entry = {
      ...entry,
      launchError: started?.error || { code: "agent_not_detected" },
      status: "starting",
    };
    upsertChild(entry);
    die(`could not confirm '${name}' started in ${created.tabId}; it remains owned and open for diagnosis`);
  }

  entry = {
    ...entry,
    status: agent.agent_status || "idle",
    sessionId: agent.agent_session?.value || entry.sessionId || null,
  };
  upsertChild(entry);
  return { entry, role, launch };
}

function submitTask(entry, role, task, { wait = false, timeout, kind = "task" } = {}) {
  const live = confirmAgent(entry.name, entry.paneId);
  const status = live?.agent_status || entry.status;
  if (status === "blocked") {
    die(`'${entry.name}' is blocked: an approval or question is open in its tab; nothing was sent`);
  }
  const brief = nextBrief(entry, kind);
  brief.path = writeBrief(entry, role, task, brief);
  const args = ["agent", "prompt", entry.name, briefInstruction(brief, brief.path)];
  if (wait) {
    args.push("--wait", ...SETTLED_STATES);
    if (timeout !== undefined) args.push("--timeout", String(timeout));
    brief.delivery = "confirmed";
  } else if (status === "working") {
    // Herdr's --wait matches a state change, and a working child shows none until its
    // turn ends; Codex queues the input behind that turn. Send without the wait and let
    // the transcript confirm the receipt, instead of calling a delivered message a timeout.
    brief.delivery = "sent";
  } else {
    // A long Codex bracketed paste can still be sitting in the composer after Herdr has
    // written it. Waiting for the first semantic transition proves that Enter was consumed
    // before spawn returns, without waiting for the whole child task.
    args.push("--wait", ...PROMPT_START_STATES, "--timeout", String(PROMPT_START_TIMEOUT_MS));
    brief.delivery = "confirmed";
  }
  entry = { ...entry, briefs: [...(entry.briefs || []), brief] };
  upsertChild(entry);
  const submitted = herdrJson(args, { allowFailure: true });
  if (!submitted?.result?.agent) {
    const code = submitted?.error?.code || "unknown";
    upsertChild({
      ...entry,
      briefs: entry.briefs.map((item) => (item.id === brief.id ? { ...item, delivery: `failed:${code}` } : item)),
    });
    const hint = code === "agent_prompt_stalled"
      ? "Herdr saw no state change within 5 s; the text may sit in the composer, open the tab"
      : submitted?.error?.message || "unknown Herdr error";
    die(`could not deliver ${brief.id} to '${entry.name}' (${code}): ${hint}`);
  }
  const agent = submitted.result.agent;
  const updated = {
    ...entry,
    status: agent.agent_status || status || "working",
    sessionId: agent.agent_session?.value || entry.sessionId || null,
    lastPromptAt: brief.sentAt,
  };
  upsertChild(updated);
  // A queued brief rides the watcher the running turn already has.
  if (brief.delivery !== "sent") startWatcher(updated.name);
  return { entry: updated, brief };
}

function cmdSpawn(opts) {
  const role = loadRole(opts.role);
  const task = taskText(opts);
  if (!task) die("spawn needs --task <complete brief> or --task-file <path>");
  const name = spawnName(role.name, opts.name);
  const cwd = resolve(opts.cwd === true ? die("--cwd needs a value") : opts.cwd || process.cwd());
  const launched = launchChild({ name, role, cwd, opts });
  const { entry } = submitTask(launched.entry, role, task);
  console.log(JSON.stringify({
    ...entry,
    next: `visible child launched; run result ${name} --wait to collect its answer`,
  }, null, 2));
}

function refreshEntry(entry) {
  if (entry.stoppedAt) return entry;
  const agent = confirmAgent(entry.name, entry.paneId);
  if (!agent) return { ...entry, status: "unknown" };
  return {
    ...entry,
    status: agent.agent_status || "unknown",
    sessionId: agent.agent_session?.value || entry.sessionId || null,
  };
}

function cmdList(opts) {
  const entries = readRegistry({ strict: true }).children.map((entry) => {
    const refreshed = refreshEntry(entry);
    const full = enrich(refreshed).entry;
    upsertChild({ ...refreshed, briefs: full.briefs });
    return full;
  });
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (!entries.length) {
    console.log("no Codex children owned by this parent session");
    return;
  }
  const pad = (value, size) => String(value ?? "-").padEnd(size);
  console.log(`${pad("NAME", 24)}${pad("ROLE", 13)}${pad("STATUS", 10)}${pad("KIND", 10)}${pad("MIN", 8)}TAB`);
  for (const entry of entries) {
    const minutes = entry.elapsedMin === null ? "-" : `${entry.elapsedMin}${entry.overBudget ? "!" : ""}`;
    console.log(`${pad(entry.name, 24)}${pad(entry.role, 13)}${pad(entry.status, 10)}${pad(entry.kind, 10)}${pad(minutes, 8)}${entry.tabId || "-"}`);
  }
}

function waitForAgent(entry, opts = {}) {
  const args = ["agent", "wait", entry.name, ...SETTLED_STATES, "--until", "unknown"];
  if (opts.timeout !== undefined) {
    if (opts.timeout === true || !Number.isFinite(Number(opts.timeout)) || Number(opts.timeout) <= 0) {
      die("--timeout needs a positive number of milliseconds");
    }
    args.push("--timeout", String(Math.round(Number(opts.timeout))));
  }
  const waited = herdrJson(args, { allowFailure: true });
  if (!waited?.result?.agent) {
    die(`wait for '${entry.name}' failed: ${waited?.error?.message || "unknown Herdr error"}`);
  }
  const agent = waited.result.agent;
  const updated = {
    ...entry,
    status: agent.agent_status || "unknown",
    sessionId: agent.agent_session?.value || entry.sessionId || null,
  };
  upsertChild(updated);
  return updated;
}

function cmdWait(name, opts) {
  const entry = waitForAgent(requireOwned(name), opts);
  console.log(JSON.stringify({ name, status: entry.status, sessionId: entry.sessionId || null }, null, 2));
}

function findFileContaining(root, needle) {
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let items;
    try { items = readdirSync(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const item of items) {
      const path = join(directory, item.name);
      if (item.isDirectory()) stack.push(path);
      else if (item.isFile() && item.name.includes(needle) && item.name.endsWith(".jsonl")) return path;
    }
  }
  return null;
}

function codexHome() {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
}

function transcriptPath(sessionId) {
  for (const root of [join(codexHome(), "sessions"), join(codexHome(), "archived_sessions")]) {
    const found = findFileContaining(root, sessionId);
    if (found) return found;
  }
  return null;
}

function readTranscript(sessionId) {
  const path = sessionId ? transcriptPath(sessionId) : null;
  if (!path) return null;
  const events = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { /* a partial final line */ }
  }
  return events;
}

function assistantText(payload) {
  if (payload?.type !== "message" || payload.role !== "assistant") return null;
  const text = (payload.content || [])
    .filter((item) => ["output_text", "text"].includes(item?.type))
    .map((item) => item.text || "")
    .join("")
    .trim();
  return text || null;
}

// The Codex rollout is the child's own record. task_started and task_complete bound a
// turn, so the last assistant message inside a finished turn is a final and one inside a
// running turn is progress; a user message quoting a brief's file name is that brief's
// receipt; token_count carries the usage.
function transcriptState(sessionId, briefs = []) {
  const events = readTranscript(sessionId);
  if (!events) return null;
  const state = { turns: [], running: null, lastAssistant: null, usage: null, acknowledged: {} };
  for (const event of events) {
    const payload = event.payload || {};
    if (event.type === "event_msg") {
      if (payload.type === "task_started") {
        state.running = { startedAt: event.timestamp };
        state.lastAssistant = null;
      } else if (payload.type === "task_complete") {
        state.turns.push({
          startedAt: state.running?.startedAt || null,
          completedAt: event.timestamp,
          text: payload.last_agent_message?.trim() || state.lastAssistant,
        });
        state.running = null;
      } else if (payload.type === "token_count" && payload.info?.total_token_usage) {
        state.usage = payload.info.total_token_usage;
      }
      continue;
    }
    if (event.type !== "response_item" || payload.type !== "message") continue;
    if (payload.role === "assistant") state.lastAssistant = assistantText(payload) || state.lastAssistant;
    if (payload.role !== "user") continue;
    const text = (payload.content || []).map((part) => part.text || "").join("");
    for (const brief of briefs) {
      if (!state.acknowledged[brief.id] && brief.path && text.includes(basename(brief.path))) {
        state.acknowledged[brief.id] = event.timestamp;
      }
    }
  }
  return state;
}

// The child may bold or punctuate the line; only brief ids count.
function parseCloses(text) {
  const head = (text || "").split(/\r?\n/).slice(0, 3).join("\n");
  const match = /^[\s*_`#]*closes[\s*_`]*:?\s*(.+)$/im.exec(head);
  if (!match) return [];
  return match[1]
    .split(/[,\s]+/)
    .map((id) => id.replace(/[`*_.]/g, "").toLowerCase())
    .filter((id) => /^b\d+$/.test(id));
}

// final: a turn finished after the latest brief was sent, and that brief's receipt is in
// it. progress: a turn is running. stale: the child has not answered the latest brief.
// blocked: Herdr reports an approval or question open in the tab.
function resultKind(entry, state) {
  const latest = (entry.briefs || []).at(-1);
  const since = latest?.sentAt || entry.lastPromptAt || entry.startedAt || "";
  if (entry.status === "blocked") return { kind: "blocked", text: state?.lastAssistant || null };
  if (!state) return { kind: "none", text: null };
  if (state.running) return { kind: "progress", text: state.lastAssistant };
  const receipt = latest ? state.acknowledged[latest.id] : null;
  const finished = state.turns
    .filter((turn) => turn.completedAt >= since && (!latest || (receipt && receipt <= turn.completedAt)))
    .at(-1);
  if (finished) return { kind: "final", text: finished.text };
  return { kind: "stale", text: state.turns.at(-1)?.text || null };
}

function enrich(entry) {
  const briefs = entry.briefs || [];
  const state = transcriptState(entry.sessionId, briefs);
  const { kind, text } = resultKind(entry, state);
  const now = Date.now();
  const minutes = (ms) => Math.round(ms / 6_000) / 10;
  const activeMs = state
    ? state.turns.reduce((sum, turn) => sum + (turn.startedAt ? Date.parse(turn.completedAt) - Date.parse(turn.startedAt) : 0), 0)
      + (state.running ? now - Date.parse(state.running.startedAt) : 0)
    : null;
  const usage = state?.usage;
  const until = entry.stoppedAt ? Date.parse(entry.stoppedAt) : now;
  return {
    entry: {
      ...entry,
      briefs: briefs.map((brief) => ({
        ...brief,
        acknowledgedAt: state?.acknowledged[brief.id] || brief.acknowledgedAt || null,
      })),
      kind,
      closes: kind === "final" ? parseCloses(text) : [],
      elapsedMin: entry.startedAt ? minutes(until - Date.parse(entry.startedAt)) : null,
      activeMin: activeMs === null ? null : minutes(activeMs),
      overBudget: Boolean(entry.deadline && !entry.stoppedAt && kind !== "final" && now > Date.parse(entry.deadline)),
      usage: usage
        ? {
          totalTokens: usage.total_tokens,
          inputTokens: usage.input_tokens,
          cachedInputTokens: usage.cached_input_tokens,
          outputTokens: usage.output_tokens,
        }
        : null,
    },
    text,
  };
}

function terminalFallback(entry, lines = 200) {
  const target = entry.name || entry.paneId;
  const result = runHerdr([
    "agent", "read", target, "--source", "recent-unwrapped",
    "--lines", String(lines), "--format", "text",
  ], { allowFailure: true });
  return (result.stdout || result.stderr || "").trim();
}

function cmdResult(name, opts) {
  let entry = requireOwned(name);
  entry = opts.wait ? waitForAgent(entry, opts) : refreshEntry(entry);
  // The transcript can trail Herdr's state by a moment; a settled child gets that long.
  let full = enrich(entry);
  const deadline = Date.now() + RESULT_SETTLE_MS;
  while (
    ["done", "idle"].includes(entry.status)
    && ["progress", "none"].includes(full.entry.kind)
    && Date.now() < deadline
  ) {
    sleepSync(100);
    full = enrich(entry);
  }
  upsertChild({ ...entry, briefs: full.entry.briefs });
  const { kind, closes, briefs, overBudget } = full.entry;
  const source = full.text ? "transcript" : "terminal";
  const text = full.text || terminalFallback(entry, opts.lines === true ? 200 : Number(opts.lines) || 200);
  if (opts.json) {
    console.log(JSON.stringify({
      name,
      status: entry.status,
      kind,
      closes,
      briefs,
      sessionId: entry.sessionId || null,
      elapsedMin: full.entry.elapsedMin,
      activeMin: full.entry.activeMin,
      budgetMin: entry.budgetMin ?? null,
      overBudget,
      usage: full.entry.usage,
      source,
      text,
    }, null, 2));
    return;
  }
  const receipts = briefs.map((brief) => `${brief.id} ${brief.acknowledgedAt ? "acknowledged" : brief.delivery || "-"}`).join(", ");
  console.log([
    `# ${name}: ${kind}, status ${entry.status}`,
    closes.length ? `closes ${closes.join(", ")}` : null,
    `briefs ${receipts || "-"}`,
    overBudget ? "over budget" : null,
  ].filter(Boolean).join("; "));
  console.log(text || `(no result available for '${name}')`);
}

function cmdMessage(name, opts, positional) {
  const entry = requireOwned(name);
  if (entry.stoppedAt) die(`'${name}' is stopped; resume it before sending another message`);
  const message = opts.message === true
    ? die("--message needs a value")
    : opts.message || positional.join(" ");
  if (!message?.trim()) die("message needs --message <text>");
  const role = loadRole(entry.role);
  const { entry: updated, brief } = submitTask(entry, role, message.trim(), {
    wait: Boolean(opts.wait),
    timeout: opts.timeout,
    kind: "follow-up",
  });
  console.log(JSON.stringify({
    name,
    status: updated.status,
    sessionId: updated.sessionId || null,
    brief: { id: brief.id, amends: brief.amends, delivery: brief.delivery },
    next: brief.delivery === "sent"
      ? `queued behind the running turn; result ${name} --json shows acknowledgedAt on ${brief.id} once the child reads it`
      : `delivered; result ${name} --wait collects the answer that closes ${[...brief.amends, brief.id].join(", ")}`,
  }, null, 2));
}

function cmdStop(name) {
  const entry = requireOwned(name);
  if (entry.stoppedAt) {
    console.log(`'${name}' is already stopped`);
    return;
  }
  if (!entry.tabId) die(`no owned tab id recorded for '${name}'`);
  herdrJson(["tab", "close", entry.tabId]);
  upsertChild({ ...entry, status: "stopped", stoppedAt: new Date().toISOString() });
  console.log(`stopped ${name} (${entry.tabId})`);
}

function cmdStopAll() {
  const running = readRegistry({ strict: true }).children.filter((entry) => !entry.stoppedAt);
  if (!running.length) {
    console.log("no running Codex children owned by this parent session");
    return;
  }
  for (const entry of running) cmdStop(entry.name);
}

function cmdForget(name) {
  const entry = requireOwned(name);
  if (!entry.stoppedAt && confirmAgent(entry.name, entry.paneId)) {
    die(`'${name}' is still live; stop it before forgetting ownership`);
  }
  updateRegistry((registry) => {
    registry.children = registry.children.filter((child) => child.name !== name);
  });
  const briefDirectory = resolve(dirname(registryPath()), "briefs");
  const briefPaths = [...(entry.briefPaths || []), ...(entry.briefs || []).map((brief) => brief.path).filter(Boolean)];
  for (const path of briefPaths) {
    const candidate = resolve(path);
    if (dirname(candidate) === briefDirectory) rmSync(candidate, { force: true });
  }
  console.log(`forgot ${name}`);
}

function cmdResume(name, opts) {
  const prior = requireOwned(name);
  if (!prior.stoppedAt) die(`'${name}' is not stopped`);
  if (!prior.sessionId) die(`no Codex session id is recorded for '${name}'; retrieve its result before stopping`);
  const role = loadRole(prior.role);
  const launched = launchChild({
    name,
    role,
    cwd: prior.cwd,
    opts,
    resumeSessionId: prior.sessionId,
    prior,
  });
  const notes = [];
  if (launched.launch.modelSource === "override" && prior.model && prior.model !== launched.launch.model) {
    notes.push(`model override ${launched.launch.model} replaces recorded ${prior.model}`);
  }
  if (launched.launch.reasoningSource === "override" && prior.reasoning && prior.reasoning !== launched.launch.reasoning) {
    notes.push(`reasoning override ${launched.launch.reasoning} replaces recorded ${prior.reasoning}`);
  }
  if (prior.budgetMin && opts.budgetMin === undefined) notes.push("the earlier budget is not carried; pass --budget-min to set one");
  const task = taskText(opts);
  const kind = (prior.briefs || []).length ? "follow-up" : "task";
  const entry = task ? submitTask(launched.entry, role, task, { kind }).entry : launched.entry;
  console.log(JSON.stringify({ ...entry, notes, next: task ? "follow-up delivered" : "resumed and idle" }, null, 2));
}

function notify(title, body, sound) {
  herdrJson([
    "notification", "show", title, "--body", body, "--position", "bottom-right", "--sound", sound,
  ], { allowFailure: true });
}

function cmdWatch(name) {
  if (!NAME_RE.test(name || "")) process.exit(0);
  const entry = readRegistry().children.find((child) => child.name === name);
  const remaining = entry?.deadline ? Date.parse(entry.deadline) - Date.now() : null;
  const args = ["agent", "wait", name, ...SETTLED_STATES, "--until", "unknown"];
  if (remaining !== null) args.push("--timeout", String(Math.max(remaining, 1_000)));
  const waited = herdrJson(args, { allowFailure: true });
  const status = waited?.result?.agent?.agent_status;
  // A wait that ends with no settled state ended on the budget.
  if (!status || status === "working") {
    if (remaining !== null) {
      notify(
        "Herdr agent over budget",
        `${name} is still working past its ${entry.budgetMin} min budget. The leader decides: stop it or let it run.`,
        "request",
      );
    }
    process.exit(0);
  }
  if (status === "unknown") process.exit(0);
  const blocked = status === "blocked";
  notify(
    blocked ? "Herdr agent needs attention" : "Herdr agent finished",
    `${name} is ${status}. ${blocked ? "Open its tab to review the prompt." : "The leader can collect its result."}`,
    blocked ? "request" : "done",
  );
}

function cmdDoctor() {
  let failed = false;
  const check = (ok, message) => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${message}`);
    failed ||= !ok;
  };
  check(process.env.HERDR_ENV === "1", "running inside Herdr");
  check(Boolean(process.env.HERDR_WORKSPACE_ID), `workspace context (${process.env.HERDR_WORKSPACE_ID || "unset"})`);
  const herdrVersion = runHerdr(["--version"], { allowFailure: true });
  check(herdrVersion.status === 0, `Herdr CLI callable (${(herdrVersion.stdout || "").trim() || "no output"})`);
  let executable = null;
  try { executable = resolveWindowsCodexExecutable(); }
  catch (error) { check(false, error.message); }
  if (process.platform === "win32" && executable) check(true, `native Windows Codex executable (${executable})`);
  const permission = codexPermissionArgs();
  check(Boolean(permission.profile), `parent permission profile (${permission.description})`);
  try {
    updateRegistry(() => {});
    check(true, `registry writable (${registryPath()})`);
  } catch (error) {
    check(false, `registry not writable: ${error.message}`);
  }
  process.exitCode = failed ? 1 : 0;
}

function usage() {
  console.error([
    "usage: codex-subagents.mjs <command> [options]",
    "",
    "  spawn --role <role> --task <brief> [--name <name>] [--cwd <dir>] [--model <m>] [--reasoning <r>] [--budget-min <n>]",
    "  list [--json]                       status, kind, minutes, budget flag per child",
    "  message <name> --message <text> [--wait]   a follow-up brief; queued when the child is working",
    "  wait <name> [--timeout <ms>]",
    "  result <name> [--wait] [--timeout <ms>] [--json]   kind: final, progress, stale, blocked",
    "  stop <name> | stop-all",
    "  resume <name> [--task <follow-up>] [--model <m>] [--reasoning <r>] [--budget-min <n>]   keeps the recorded model",
    "  forget <name>",
    "  doctor",
  ].join("\n"));
}

function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv;
    const { opts, positional } = parseArgs(rest);
    switch (command) {
      case "spawn": cmdSpawn(opts); break;
      case "list": cmdList(opts); break;
      case "message": cmdMessage(positional.shift() || die("message needs a name"), opts, positional); break;
      case "wait": cmdWait(positional[0] || die("wait needs a name"), opts); break;
      case "result": cmdResult(positional[0] || die("result needs a name"), opts); break;
      case "stop": cmdStop(positional[0] || die("stop needs a name")); break;
      case "stop-all": cmdStopAll(); break;
      case "resume": cmdResume(positional[0] || die("resume needs a name"), opts); break;
      case "forget": cmdForget(positional[0] || die("forget needs a name")); break;
      case "doctor": cmdDoctor(); break;
      case "_watch": cmdWatch(positional[0]); break;
      default:
        usage();
        process.exitCode = 2;
    }
  } catch (error) {
    console.error(`codex-subagents: ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
const invokedDirectly = invokedPath && (() => {
  try { return realpathSync(invokedPath) === realpathSync(SCRIPT_PATH); }
  catch { return false; }
})();
if (invokedDirectly) main();

export {
  codexPermissionArgs,
  main,
  normalizePermissionProfile,
  parseArgs,
  parseCloses,
  parseFrontmatter,
  resolveWindowsCodexExecutable,
  resultKind,
  tabEnvironmentArgs,
  transcriptState,
};
