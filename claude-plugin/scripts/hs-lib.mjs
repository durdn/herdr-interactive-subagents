// Import-safe implementation for hs.mjs. Claude Code owns messaging and session
// persistence; Herdr owns tabs and lifecycle; this module owns the small spawn,
// registry, callback, and installation contract between them.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <plugin>/scripts/hs-lib.mjs, so the plugin root is one up.
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
const HERDR_TIMEOUT_MIN_MS = 3000; // `herdr agent start --timeout` wants more than this,
const HERDR_TIMEOUT_MAX_MS = 300000; // and at most this. Both are its own limits, not ours.
const validTimeout = (value, fallback) => {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > HERDR_TIMEOUT_MIN_MS && ms <= HERDR_TIMEOUT_MAX_MS
    ? Math.round(ms)
    : fallback;
};
// What `agent start --timeout` bounds is DETECTION, not startup. On a loaded box
// an Opus child with the full plugin set is still undetected well past the 60s
// this used to hardcode, while the child itself runs fine - so the deadline is
// raised, it is settable, and reaching it is never taken as proof that nothing
// started (see confirmAgentPresent).
const AGENT_START_TIMEOUT_MS = validTimeout(process.env.HS_AGENT_START_TIMEOUT_MS, 90000);
// --no-wait still has to let `agent start` type the command line and answer;
// this is how long that costs, not how long a child takes to come up.
const NO_WAIT_TIMEOUT_MS = validTimeout(process.env.HS_NO_WAIT_TIMEOUT_MS, 5000);
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// This is deliberately supplied separately from every role. A role defines what
// a useful result contains; this system-level instruction defines how every
// child returns it, including custom roles and sessions resumed without a seed.
const CALLBACK_PROMPT_PATH = join(PLUGIN_DIR, "callback-prompt.md");
const CALLBACK_SYSTEM_PROMPT = readFileSync(CALLBACK_PROMPT_PATH, "utf8").trim();

// -- shell out -------------------------------------------------------------

function herdrCommand() {
  const configured = process.env.HERDR_BIN_PATH?.trim();
  // A JS executable is useful for portable no-model test doubles, especially on
  // Windows where spawnSync cannot execute .cmd wrappers without a shell.
  if (configured?.endsWith(".mjs")) return [process.execPath, configured];
  return [configured || "herdr"];
}

function herdr(args, { allowFailure = false } = {}) {
  const [command, ...prefix] = herdrCommand();
  const r = spawnSync(command, [...prefix, ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
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

class HsError extends Error {}

function die(message) {
  throw new HsError(message);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Start a child in a pane that may still be booting its shell. A fixed sleep
// loses this race on a loaded box - a fresh pane here needs seconds, not the
// 600ms it used to wait - so ask Herdr rather than guess: retry for as long as
// it says the pane is busy, and hand any other outcome back to the caller to
// report. agent_not_ready is NOT retried; that child started and is blocked.
function startAgentInPane(name, paneId, agentArgs, detectionTimeoutMs = AGENT_START_TIMEOUT_MS) {
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  for (;;) {
    sleepSync(SHELL_READY_MS);
    const started = herdrJson(
      ["agent", "start", name, "--kind", "claude", "--pane", paneId,
        "--timeout", String(detectionTimeoutMs), "--", ...agentArgs],
      { allowFailure: true },
    );
    if (started?.result?.agent) return started;
    if (started?.error?.code !== "agent_pane_busy" || Date.now() >= deadline) return started;
  }
}

/**
 * Herdr's detection wait is advisory. A child can be live in `agent list` while
 * `agent start` reports it never came up - four of five failed spawns in the
 * field were exactly that - so ask the agent registry before believing it.
 *
 * Herdr assigns the agent NAME only when `agent start` succeeds, so a child that
 * missed detection is nameless there: `agent get <name>` answers agent_not_found
 * for a session that is sitting idle in its tab. Its pane is the handle that
 * still resolves, and we have it from `tab create`.
 */
function confirmAgentPresent(name, paneId) {
  const byName = herdrJson(["agent", "get", name], { allowFailure: true });
  if (byName?.result?.agent) return byName.result.agent;
  if (!paneId) return null;
  const byPane = herdrJson(["agent", "get", paneId], { allowFailure: true });
  return byPane?.result?.agent || null;
}

function clampStartTimeout(raw, fallback) {
  if (raw === undefined) return fallback;
  if (raw === true) die("--startup-timeout needs a value in milliseconds");
  const ms = validTimeout(raw, null);
  if (ms === null) {
    die(`--startup-timeout must be more than ${HERDR_TIMEOUT_MIN_MS} and at most `
      + `${HERDR_TIMEOUT_MAX_MS} ms`);
  }
  return ms;
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

/** This session's own inbox. A child copies it verbatim as SendMessage's `to`. */
function replyAddress() {
  return (process.env.CLAUDE_CODE_MESSAGING_SOCKET || "").trim();
}

/** Windows separators do not survive two layers of shell quoting; slashes do. */
function fwd(p) {
  return p.split("\\").join("/");
}

function briefsDir() {
  return join(homedir(), ".claude", "herdr-subagents", parentSessionId(), "briefs");
}

function taskText(opts) {
  if (opts.task === true || opts.taskFile === true) die("--task/--task-file need a value");
  if (opts.task && opts.taskFile) die("pass --task or --task-file, not both");
  if (opts.taskFile) {
    const p = resolve(opts.taskFile);
    if (!existsSync(p)) die("--task-file does not exist: " + p);
    return readFileSync(p, "utf8").trim();
  }
  const t = [].concat(opts.task || []).filter((x) => typeof x === "string").join("\n").trim();
  return t || null;
}

/**
 * Hand the task over as a file rather than as argv. Herdr starts a child by
 * typing its command line into the pane's shell, so a task passed inline has to
 * survive two quoting layers and cannot contain a newline at all. A path can.
 * The brief also carries the reply address, which is the other half of what a
 * task message used to supply.
 */
function writeBrief(name, task) {
  const dir = briefsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name + ".md");
  writeFileSync(path, [
    "# Task brief",
    "",
    "Reply address: " + replyAddress(),
    "",
    "## The task",
    "",
    task,
    "",
  ].join("\n"));
  return path;
}

// -- registry --------------------------------------------------------------
// Only records what Herdr cannot: which children THIS orchestrator owns, and
// with which role. Live state is always read back from Herdr.

function ownershipRoot() {
  return join(homedir(), ".claude", "herdr-subagents");
}

function registryPath() {
  return join(ownershipRoot(), parentSessionId(), "registry.json");
}

function readRegistry({ strict = false } = {}) {
  const p = registryPath();
  if (!existsSync(p)) return { children: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!Array.isArray(parsed?.children)) throw new Error("missing children array");
    return parsed;
  } catch (error) {
    if (strict) die(`registry is corrupt at ${p}: ${error.message}`);
    return { children: [] };
  }
}

const REGISTRY_LOCK_LEASE_MS = 30_000;
const REGISTRY_LOCK_WAIT_MS = 5_000;

function lockProcessState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    // EPERM means the process exists but is owned by somebody else. Only ESRCH
    // is positive evidence that a crashed owner cannot still be in its section.
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

function lockOwner(lock) {
  try { return JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")); }
  catch { return null; }
}

function lockIsReclaimable(lock) {
  const owner = lockOwner(lock);
  if (owner?.token) {
    if (existsSync(join(lock, `released-${owner.token}`))) return true;
    const processState = lockProcessState(owner.pid);
    if (processState === "dead") return true;
    // Never evict a known-live owner merely because it was descheduled past a
    // timestamp. The lease is a fallback only where PID probing is unavailable
    // or old metadata did not contain a usable PID.
    if (processState === "alive") return false;
    return Number.isFinite(owner.leaseUntil) && owner.leaseUntil <= Date.now();
  }
  // mkdir and publishing owner.json are separate filesystem operations. Do not
  // mistake that tiny window (or a partially-written record) for a stale lock.
  try { return lstatSync(lock).mtimeMs + REGISTRY_LOCK_LEASE_MS <= Date.now(); }
  catch { return true; }
}

function reclaimRegistryLock(lock) {
  const stale = `${lock}.stale-${process.pid}-${randomUUID()}`;
  try {
    // Renaming is the ownership hand-off: only one waiter can move this exact
    // generation away, and a late release from its old owner cannot delete the
    // new canonical lock directory.
    renameSync(lock, stale);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  rmSync(stale, { recursive: true, force: true });
  return true;
}

function acquireRegistryLock(lock) {
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  for (;;) {
    const token = randomUUID();
    try {
      mkdirSync(lock);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockIsReclaimable(lock) && reclaimRegistryLock(lock)) continue;
      if (Date.now() >= deadline) throw error;
      sleepSync(10);
      continue;
    }

    const owner = {
      version: 1, token, pid: process.pid,
      createdAt: new Date().toISOString(),
      leaseUntil: Date.now() + REGISTRY_LOCK_LEASE_MS,
    };
    try {
      // wx matters if this process was suspended after mkdir and a waiter
      // legitimately retired that unpublished generation. It must not overwrite
      // the successor's owner record when it wakes up.
      writeFileSync(join(lock, "owner.json"), JSON.stringify(owner), { flag: "wx" });
      if (lockOwner(lock)?.token === token) return { lock, token };
    } catch (error) {
      if (!["EEXIST", "ENOENT"].includes(error?.code)) throw error;
    }
    if (Date.now() >= deadline) throw new Error(`could not publish registry lock ownership at ${lock}`);
  }
}

function releaseRegistryLock(held) {
  try {
    // The owner never removes the canonical directory. A token-specific marker
    // lets the next waiter retire it atomically; if this write races a stale
    // takeover and lands in a successor, the mismatched token is ignored.
    writeFileSync(join(held.lock, `released-${held.token}`), "", { flag: "wx" });
  } catch { /* a stale takeover already retired this generation */ }
}

function withRegistryLock(run) {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  const held = acquireRegistryLock(p + ".lock");
  try { return run(); }
  finally { releaseRegistryLock(held); }
}

function writeRegistryUnlocked(reg) {
  const p = registryPath();
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  try { renameSync(tmp, p); }
  catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function writeRegistry(reg) {
  withRegistryLock(() => writeRegistryUnlocked(reg));
}

function upsertChild(entry) {
  withRegistryLock(() => {
    const reg = readRegistry({ strict: true });
    const existing = reg.children.find((c) => c.name === entry.name);
    if (existing?.sessionId && entry.sessionId && existing.sessionId !== entry.sessionId) {
      die(`refusing to replace owned child '${entry.name}' (${existing.sessionId}) with ${entry.sessionId}`);
    }
    reg.children = reg.children.filter((c) => c.name !== entry.name).concat(entry);
    writeRegistryUnlocked(reg);
  });
}

function claimDir(kind, key) {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(ownershipRoot(), "claims", `${kind}s`, digest);
}

function readClaim(kind, key) {
  const path = claimDir(kind, key);
  try {
    return { path, record: JSON.parse(readFileSync(join(path, "claim.json"), "utf8")) };
  } catch {
    return existsSync(path) ? { path, record: null } : null;
  }
}

function tryClaim(kind, key, details = {}) {
  const path = claimDir(kind, key);
  mkdirSync(dirname(path), { recursive: true });
  try { mkdirSync(path); }
  catch (error) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }
  const claim = {
    version: 1, kind, key, token: randomUUID(), pid: process.pid,
    parent: parentSessionId(), createdAt: new Date().toISOString(), ...details,
  };
  try {
    writeFileSync(join(path, "claim.json"), JSON.stringify(claim, null, 2));
    return { path, record: claim };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

function releaseClaim(claim) {
  if (!claim) return false;
  try {
    const current = JSON.parse(readFileSync(join(claim.path, "claim.json"), "utf8"));
    if (current?.token !== claim.record?.token || current?.key !== claim.record?.key) return false;
    rmSync(claim.path, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

function legacyNameOwner(name) {
  const root = ownershipRoot();
  if (!existsSync(root)) return null;
  for (const child of readdirSync(root)) {
    if (child === "claims") continue;
    const p = join(root, child, "registry.json");
    if (!existsSync(p)) continue;
    try {
      const found = JSON.parse(readFileSync(p, "utf8"))?.children?.find((c) => c.name === name);
      if (found) return { parent: child, entry: found };
    } catch {
      // Corrupt legacy ownership is ambiguous. Reserve its parent directory's
      // names by refusing mutations only when it is this caller's registry.
      if (child === parentSessionId()) readRegistry({ strict: true });
    }
  }
  return null;
}

function claimNewName(name, sessionId) {
  if (legacyNameOwner(name)) return null;
  const claim = tryClaim("name", name, { name, sessionId });
  if (!claim) return null;
  if (legacyNameOwner(name)) {
    releaseClaim(claim);
    return null;
  }
  return claim;
}

function ensureOwnedNameClaim(entry) {
  const existing = readClaim("name", entry.name);
  if (existing) {
    if (existing.record?.parent !== parentSessionId()
      || (existing.record?.sessionId && existing.record.sessionId !== entry.sessionId)) {
      die(`name '${entry.name}' is claimed by ${existing.record?.parent || existing.path}`);
    }
    return existing;
  }
  const owner = legacyNameOwner(entry.name);
  if (owner && owner.parent !== parentSessionId()) {
    die(`name '${entry.name}' is owned by parent session ${owner.parent}`);
  }
  return tryClaim("name", entry.name, { name: entry.name, sessionId: entry.sessionId });
}

function claimSessionRun(entry) {
  return tryClaim("session", entry.sessionId, { name: entry.name, sessionId: entry.sessionId });
}

/**
 * Stopping closes the tab but not the Claude session, which stays resumable by
 * its id. Keep the entry and mark it, or `resume` would have nothing to replay.
 */
function markStopped(name) {
  return withRegistryLock(() => {
    const reg = readRegistry({ strict: true });
    const entry = reg.children.find((c) => c.name === name) || null;
    if (entry) {
      entry.stoppedAt = new Date().toISOString();
      writeRegistryUnlocked(reg);
    }
    return entry;
  });
}

function forgetChild(name) {
  return withRegistryLock(() => {
    const reg = readRegistry({ strict: true });
    const before = reg.children.length;
    reg.children = reg.children.filter((c) => c.name !== name);
    writeRegistryUnlocked(reg);
    return reg.children.length < before;
  });
}

// -- roles -----------------------------------------------------------------

function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const fields = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      listKey = kv[1].toLowerCase();
      fields[listKey] = kv[2].trim();
      continue;
    }
    const item = listKey && line.match(/^\s+-\s*(.+?)\s*$/);
    if (item) fields[listKey] = [fields[listKey], item[1]].filter(Boolean).join(", ");
    else if (line.trim()) listKey = null;
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

function listedTools(raw) {
  return String(raw ?? "").replace(/[\[\]'"`]/g, " ").split(/[\s,]+/).filter(Boolean);
}

function denyMatchesTool(spec, tool) {
  const pattern = spec.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${pattern}$`).test(tool);
}

function validateCallbackRole(role, permissionMode) {
  const allowedModes = ["acceptEdits", "auto", "default", "manual", "dontAsk", "plan"];
  if (permissionMode === "bypassPermissions") {
    die("permission mode 'bypassPermissions' is callback-incompatible because outbound messages require approval");
  }
  if (!allowedModes.includes(permissionMode)) {
    die(`unknown permission mode '${permissionMode}' (${allowedModes.join(", ")})`);
  }

  // Omitted tools inherit the full set; an explicit empty list grants nothing.
  // Claude's separate disallowedTools field takes precedence and accepts globs.
  // SendMessage itself has no supported parenthesized permission specifier.
  const tools = Object.hasOwn(role, "tools") ? listedTools(role.tools) : null;
  const allowed = tools === null || tools.includes("SendMessage");
  const denied = listedTools(role.disallowedtools).some((spec) =>
    denyMatchesTool(spec, "SendMessage"));
  if (!allowed || denied) {
    die(`role '${role.name}' cannot report callbacks: its tool policy must allow SendMessage`);
  }
}

function ensureCallbackPrompt(argv) {
  const kept = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--append-system-prompt", "--append-system-prompt-file"].includes(argv[i])) {
      i++; // Replace an older copy with the current authoritative contract.
      continue;
    }
    kept.push(argv[i]);
  }
  // A file avoids sending punctuation and newlines through two PowerShell
  // quoting layers when Herdr types the child command into its pane.
  kept.push("--append-system-prompt-file", fwd(CALLBACK_PROMPT_PATH));
  return kept;
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
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

function claimLaunchName(base, sessionId, { explicit }) {
  const live = liveAgentNames();
  const candidates = explicit
    ? [base]
    : Array.from({ length: 99 }, (_, i) => i === 0 ? base : `${base.slice(0, 29)}-${i + 1}`);
  for (const candidate of candidates) {
    if (live.has(candidate)) {
      if (explicit) die(`explicit name '${candidate}' is already live`);
      continue;
    }
    const claim = claimNewName(candidate, sessionId);
    if (claim) return { name: candidate, claim };
    if (explicit) die(`explicit name '${candidate}' is already owned; choose another name`);
  }
  die(`could not claim a free name based on '${base}'`);
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

function closeTabForRollback(tabId) {
  if (!tabId) return;
  try { herdr(["tab", "close", tabId], { allowFailure: true }); } catch {}
}

function extraDirs(opts, role) {
  const raw = [].concat(opts.addDir || [], (role["add-dir"] || "").split(",")).filter(
    (d) => typeof d === "string" && d.trim(),
  );
  return raw.map((d) => resolve(d.trim()));
}

const SPAWN_USAGE = [
  "usage: hs.mjs spawn --role <name> [options]",
  "",
  "  --role <name>          required; the loadout to launch (see: hs.mjs roles)",
  "  --task <text>          the whole task; newlines and quotes are fine",
  "  --task-file <path>     read the task from a file instead of the command line",
  "  --name <handle>        [a-z][a-z0-9_-]{0,31}; default <role>-<4 hex>",
  "  --cwd <dir>            the child's working directory; must be Claude-trusted",
  "  --add-dir <dir>        one more readable directory; repeat the flag for more",
  "  --model <alias>        override the role's model (haiku, sonnet, opus, ...)",
  "  --effort <level>       low|medium|high|xhigh|max; overrides the role",
  "  --permission-mode <m>  default auto; bypassPermissions is rejected",
  `  --startup-timeout <ms> detection wait; default ${AGENT_START_TIMEOUT_MS}, max ${HERDR_TIMEOUT_MAX_MS}`,
  "  --no-wait              return as soon as the child is launched, before Herdr",
  "                         detects it - use this when spawning a batch in one call",
];

function cmdSpawn(opts) {
  if (opts.help) {
    console.log(SPAWN_USAGE.join("\n"));
    return;
  }
  requireHerdr();
  if (!opts.role) die(["spawn needs --role <name>", "", ...SPAWN_USAGE].join("\n"));
  const role = requireRole(opts.role);
  const permissionMode = opts.permissionMode || role["permission-mode"] || "auto";
  validateCallbackRole(role, permissionMode);

  const cwd = resolve(opts.cwd || role.cwd || process.cwd());
  if (!existsSync(cwd) || !lstatSync(cwd).isDirectory()) die(`cwd is not a directory: ${cwd}`);
  if (!isTrustedCwd(cwd)) {
    die([
      `${cwd} has not been trusted for Claude Code, so a child would stall on the trust dialog.`,
      "    Either spawn with --cwd set to a directory you already work in and pass",
      `    --add-dir ${cwd}, or run 'claude' there once yourself and accept the prompt.`,
    ].join("\n"));
  }

  const model = opts.model || role.model || null;
  if (model !== null && typeof model !== "string") die("--model needs one value");
  const effort = opts.effort || role.effort || null;
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) {
    die(`unknown effort '${effort}' (low, medium, high, xhigh, max)`);
  }
  // Detection is the only thing this call waits on, and the skill asks for a
  // whole fan-out in one shell call. --no-wait returns as soon as the command
  // is typed, so five spawns cost seconds instead of five detection windows.
  const noWait = Boolean(opts.noWait);
  const detectionTimeout = clampStartTimeout(
    opts.startupTimeout, noWait ? NO_WAIT_TIMEOUT_MS : AGENT_START_TIMEOUT_MS,
  );
  const task = taskText(opts);
  if (task && !replyAddress()) {
    die([
      "--task needs this session's messaging inbox, and CLAUDE_CODE_MESSAGING_SOCKET is unset,",
      "    so the child would have nowhere to report. Spawn without --task and send the task",
      "    with SendMessage instead.",
    ].join("\n"));
  }
  const additionalDirs = extraDirs(opts, role);
  for (const dir of additionalDirs) {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory()) die(`add-dir is not a directory: ${dir}`);
  }

  // Every local option is valid before ownership changes. Explicit duplicates
  // fail; generated/default names use deterministic numeric suffix attempts.
  const explicitName = Object.hasOwn(opts, "name");
  if (explicitName && (typeof opts.name !== "string" || !opts.name.trim())) {
    die("--name needs one non-empty value");
  }
  const sessionId = randomUUID();
  const base = explicitName
    ? sanitizeName(opts.name)
    : `${sanitizeName(role.name).slice(0, 24)}-${randomUUID().slice(0, 4)}`;
  if (!NAME_RE.test(base)) die(`derived name '${base}' is not a valid Herdr agent name`);
  const claimedName = claimLaunchName(base, sessionId, { explicit: explicitName });
  const { name, claim: nameClaim } = claimedName;

  let briefPath = null;
  let sessionClaim = null;
  let workspace;
  let childArgs;
  try {
    childArgs = ensureCallbackPrompt([
      "--name", name, "--session-id", sessionId,
      "--permission-mode", permissionMode, "--agent", role.name,
      "--plugin-dir", PLUGIN_DIR, "--settings", '{"crossSessionInbound":"accept"}',
    ]);
    if (model) childArgs.push("--model", model);
    if (effort) childArgs.push("--effort", effort);
    for (const dir of additionalDirs) childArgs.push("--add-dir", dir);
    if (task) {
      briefPath = writeBrief(name, task);
      childArgs.push("--add-dir", briefsDir());
    }
    try { writeShim({ quiet: true }); } catch { /* spawning does not depend on the convenience shim */ }
    workspace = callerWorkspace();
    sessionClaim = claimSessionRun({ name, sessionId });
    if (!sessionClaim) die(`session ${sessionId} is already claimed`);
  } catch (error) {
    releaseClaim(sessionClaim);
    releaseClaim(nameClaim);
    if (briefPath) rmSync(briefPath, { force: true });
    if (error instanceof HsError) throw error;
    die(`local launch preparation failed: ${error.message}`);
  }

  const seed = briefPath
    ? ["Read " + fwd(briefPath) + " and carry out the task brief it contains."]
    : [];
  let tabId = null;
  let paneId = null;
  const baseEntry = {
    name, sessionId, role: role.name, cwd, workspace, model, effort,
    parent: parentSessionId(), startedAt: new Date().toISOString(), argv: childArgs,
  };
  const registerStarting = (launchError) => {
    const entry = {
      ...baseEntry, tabId, paneId, startupUncertain: true,
      ...(launchError ? { launchError } : {}),
      ownershipClaim: nameClaim.path, sessionClaim: sessionClaim.path,
    };
    try {
      upsertChild(entry);
      return "";
    } catch (error) {
      return ` Diagnostic registry persistence also failed: ${error.message}.`;
    }
  };
  // Name the recovery. "Stop/inspect before recovery" left every reader in the
  // field guessing, and both of them burned a name rather than risk the wrong
  // command.
  const retainAmbiguous = (message) => {
    const registryError = registerStarting(message);
    die([
      message,
      "    It stays registered as 'starting', so this session still owns it:",
      "      hs.mjs list                     # does Herdr see it running?",
      // By pane, not by name: an undetected child has no name in Herdr yet.
      `      herdr agent read ${paneId || name} --source detection --lines 40`,
      `      hs.mjs stop ${name}               # if it is dead; then 'resume ${name}' to retry it,`,
      `                                      # or 'forget ${name}' to free the name`,
      `    Ownership: ${nameClaim.path}; transcript claim: ${sessionClaim.path}.${registryError}`,
    ].join("\n"));
  };
  const rollbackUnstarted = (message) => {
    closeTabForRollback(tabId);
    if (existsSync(registryPath())) forgetChild(name);
    const sessionReleased = releaseClaim(sessionClaim);
    const nameReleased = releaseClaim(nameClaim);
    if (briefPath) rmSync(briefPath, { force: true });
    if (!sessionReleased || !nameReleased) {
      die(
        `${message} Startup was ruled out, but ownership rollback was incomplete `
        + `(name: ${nameClaim.path}; transcript: ${sessionClaim.path}).`,
      );
    }
    die(message);
  };

  let created;
  try {
    created = herdrJson([
      "tab", "create", "--workspace", workspace, "--cwd", cwd,
      "--label", name, "--no-focus",
    ]);
  } catch (error) {
    retainAmbiguous(`tab creation for '${name}' returned an ambiguous failure: ${error.message}`);
  }
  tabId = created?.result?.tab?.tab_id || null;
  paneId = created?.result?.root_pane?.pane_id || null;
  if (!paneId) rollbackUnstarted(`Herdr did not return a root pane: ${JSON.stringify(created)}`);

  // Register BEFORE the detection wait, not after it. A shell tool that killed
  // this process mid-wait used to leave a live child with no registry entry at
  // all - an orphan that `list`, `result` and `stop` each denied existed.
  registerStarting(null);

  let started;
  try {
    started = startAgentInPane(name, paneId, [...seed, ...childArgs], detectionTimeout);
  } catch (error) {
    retainAmbiguous(`agent start for '${name}' returned an ambiguous failure: ${error.message}`);
  }
  // Herdr's own wait is advisory, so ask the agent registry before believing
  // it, and leave the tab open when the answer is ambiguous: closing it is what
  // killed four children out of five that had in fact started fine.
  const agent = started?.result?.agent || confirmAgentPresent(name, paneId);
  if (!agent) {
    // agent_pane_busy is the one outcome that proves nothing was typed into the
    // pane. Any other outcome, a timeout included, may have left a live child.
    const knownUnstarted = started?.error?.code === "agent_pane_busy";
    let screen = "";
    try {
      screen = herdr(["agent", "read", paneId || name, "--source", "detection", "--lines", "30"], {
        allowFailure: true,
      }).stdout || "";
    } catch {}
    const message = [
      knownUnstarted
        ? `could not start '${name}'; its pane never reached a shell prompt, so tab ${tabId} was closed.`
        : `could not confirm '${name}' started within ${detectionTimeout} ms; tab ${tabId} is still `
          + "open and the child may well be running.",
      `    ${started?.error?.message || JSON.stringify(started)}`,
      ...screen.split(/\r?\n/).filter(Boolean).slice(-12).map((l) => `    | ${l}`),
    ].join("\n");
    if (knownUnstarted) rollbackUnstarted(message);
    if (!noWait) retainAmbiguous(message);
  }

  const entry = {
    name, sessionId, role: role.name, cwd, tabId, paneId, workspace, model, effort,
    parent: parentSessionId(), startedAt: baseEntry.startedAt, argv: childArgs,
    // Only --no-wait reaches here undetected; keep it visible to `list`.
    ...(agent ? {} : {
      startupUncertain: true,
      ownershipClaim: nameClaim.path,
      sessionClaim: sessionClaim.path,
    }),
  };
  // The child is running by now, so a registry failure is a bookkeeping problem.
  // Report it; do not close the tab and throw the child's work away over it.
  try { upsertChild(entry); }
  catch (error) {
    retainAmbiguous(`child '${name}' started but its registry update failed: ${error.message}`);
  }

  const reporting = briefPath
    ? `task delivered; "${name}" reports back on its own as a cross-session message. Do not poll.`
    : `idle - send the task with SendMessage to "${name}" (add notify_when_idle: true).`;
  console.log(JSON.stringify({
    ...entry,
    brief: briefPath,
    status: agent?.agent_status || "starting",
    next: agent ? reporting : `booting in tab ${tabId}, not detected yet. ${briefPath
      ? "It reads its brief and reports back on its own; do not poll."
      : "Wait for it to reach 'hs.mjs list' before addressing it with SendMessage."}`,
  }, null, 2));
}

function cmdList(opts) {
  const reg = readRegistry();
  const live = new Map();
  const res = herdrJson(["agent", "list"], { allowFailure: true });
  const byPane = new Map();
  for (const a of res?.result?.agents || []) {
    if (a.name) live.set(a.name, a);
    if (a.pane_id) byPane.set(a.pane_id, a);
  }
  // The two sources used to disagree in silence: an empty list here while a
  // spawn refused the same name as "already live". Say what Herdr can see.
  const workspace = process.env.HERDR_WORKSPACE_ID;
  const unowned = [...live.values()].filter((a) =>
    (!workspace || a.workspace_id === workspace)
    && a.pane_id !== process.env.HERDR_PANE_ID // never offer to adopt the caller
    && !reg.children.some((c) => c.name === a.name));

  const rows = reg.children.map((c) => ({
    name: c.name,
    role: c.role,
    // A child that missed detection is live but nameless in Herdr; its pane is
    // what still identifies it, so `starting` resolves once it is really up.
    status: (live.get(c.name) || byPane.get(c.paneId))?.agent_status
      || (c.stoppedAt ? "stopped" : c.startupUncertain ? "starting" : "gone"),
    tab: c.tabId,
    cwd: c.cwd,
    sessionId: c.sessionId,
    startedAt: c.startedAt,
  }));

  if (opts.json) {
    console.log(JSON.stringify(opts.all ? { owned: rows, unowned } : rows, null, 2));
    return;
  }
  const alsoLive = () => {
    if (!unowned.length) return;
    console.log(
      `\nalso live in ${workspace || "this Herdr"}, not owned by this session: `
      + `${unowned.map((a) => `${a.name} (${a.tab_id})`).join(", ")}`
      + "\n  adopt one this session launched: hs.mjs adopt <name>",
    );
  };
  if (!rows.length) {
    console.log("no subagents owned by this session");
    alsoLive();
    return;
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad("NAME", 20)}${pad("ROLE", 14)}${pad("STATUS", 10)}${pad("TAB", 10)}CWD`);
  for (const r of rows) {
    console.log(`${pad(r.name, 20)}${pad(r.role, 14)}${pad(r.status, 10)}${pad(r.tab, 10)}${r.cwd}`);
  }
  alsoLive();
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

function cmdResume(name, opts = {}) {
  requireHerdr();
  const noWait = Boolean(opts.noWait);
  const detectionTimeout = clampStartTimeout(
    opts.startupTimeout, noWait ? NO_WAIT_TIMEOUT_MS : AGENT_START_TIMEOUT_MS,
  );
  const entry = readRegistry({ strict: true }).children.find((c) => c.name === name);
  if (!entry) die(`'${name}' is not a subagent owned by this session`);
  if (!Array.isArray(entry.argv) || !entry.argv.every((arg) => typeof arg === "string")
    || typeof entry.sessionId !== "string" || typeof entry.cwd !== "string"
    || typeof entry.role !== "string") {
    die(`'${name}' has an incomplete registry entry and cannot be resumed safely`);
  }
  const role = requireRole(entry.role);
  const replayArgv = ensureCallbackPrompt(entry.argv);
  validateCallbackRole(role, argValue(replayArgv, "--permission-mode") || "auto");
  if (!existsSync(entry.cwd) || !lstatSync(entry.cwd).isDirectory()) {
    die(`cwd is not a directory: ${entry.cwd}`);
  }
  if (!isTrustedCwd(entry.cwd)) die(`${entry.cwd} is no longer trusted for Claude Code`);
  if (liveAgentNames().has(name)) die(`'${name}' is still live; message it instead of resuming`);

  const childArgs = replayArgv.filter((a, i, all) => {
    if (a === "--session-id") return false;
    return all[i - 1] !== "--session-id";
  });
  const workspace = callerWorkspace();
  ensureOwnedNameClaim(entry); // migrates legacy registry ownership on first resume
  const sessionClaim = claimSessionRun(entry);
  if (!sessionClaim) {
    const existing = readClaim("session", entry.sessionId);
    die(`cannot resume '${name}': session ${entry.sessionId} is already claimed at ${existing?.path}; refusing to run one transcript twice`);
  }

  let tabId = null;
  let paneId = null;
  const failResume = (message, knownUnstarted) => {
    // Same rule as spawn: only a ruled-out startup earns a closed tab.
    if (knownUnstarted) closeTabForRollback(tabId);
    const released = knownUnstarted ? releaseClaim(sessionClaim) : false;
    let registryError = "";
    if (!knownUnstarted) {
      try {
        upsertChild({
          ...entry, tabId, paneId, startupUncertain: true, launchError: message,
          sessionClaim: sessionClaim.path,
        });
      } catch (error) {
        registryError = ` Diagnostic registry persistence also failed: ${error.message}.`;
      }
    }
    die(knownUnstarted
      ? released
        ? message
        : `${message} Startup was ruled out, but session ownership could not be released at ${sessionClaim.path}.`
      : [
        message,
        `    It stays registered as 'starting' in tab ${tabId || "(none)"}; session ownership retained.`,
        `      hs.mjs list                                  # does Herdr see it running?`,
        `      herdr agent read ${paneId || name} --source detection --lines 40`,
        `      hs.mjs stop ${name}                            # if it is dead - releases the session`,
        `    Transcript claim: ${sessionClaim.path}.${registryError}`,
      ].join("\n"));
  };

  let created;
  try {
    created = herdrJson([
      "tab", "create", "--workspace", workspace, "--cwd", entry.cwd,
      "--label", name, "--no-focus",
    ]);
  } catch (error) {
    failResume(`tab creation for resume '${name}' returned an ambiguous failure: ${error.message}`, false);
  }
  tabId = created?.result?.tab?.tab_id || null;
  paneId = created?.result?.root_pane?.pane_id || null;
  if (!paneId) failResume(`Herdr did not return a root pane: ${JSON.stringify(created)}`, true);

  let started;
  try {
    started = startAgentInPane(
      name, paneId, ["--resume", entry.sessionId, ...childArgs], detectionTimeout,
    );
  } catch (error) {
    failResume(`agent resume for '${name}' returned an ambiguous failure: ${error.message}`, false);
  }
  const resumed = started?.result?.agent || confirmAgentPresent(name, paneId);
  if (!resumed && !noWait) {
    failResume(
      `could not confirm '${name}' resumed within ${detectionTimeout} ms. `
      + `Response: ${JSON.stringify(started)}`,
      started?.error?.code === "agent_pane_busy",
    );
  }
  const {
    stoppedAt, startupUncertain, launchError, ownershipClaim, sessionClaim: oldSessionClaim,
    ...revived
  } = entry;
  try {
    upsertChild({
      ...revived, argv: replayArgv, tabId, paneId, resumedAt: new Date().toISOString(),
      ...(resumed ? {} : { startupUncertain: true }),
    });
  } catch (error) {
    failResume(`resumed child '${name}' but registry update failed: ${error.message}`, false);
  }
  console.log(JSON.stringify({
    name, sessionId: entry.sessionId, tabId, paneId,
    status: resumed ? "resumed" : "starting",
  }, null, 2));
}

function responseConfirmsAgentAbsent(response) {
  return response?.error?.code === "agent_not_found";
}

function cmdStop(name) {
  const entry = readRegistry({ strict: true }).children.find((c) => c.name === name);
  if (!entry) die(`'${name}' is not a subagent owned by this session (refusing to close a tab we did not create)`);

  const got = herdrJson(["agent", "get", name], { allowFailure: true });
  const tabId = entry.tabId || got?.result?.agent?.tab_id || null;
  let closureAccepted = responseConfirmsAgentAbsent(got) && !tabId;
  if (tabId) {
    const closed = herdrJson(["tab", "close", tabId], { allowFailure: true });
    closureAccepted = Boolean(closed?.result)
      || ["tab_not_found", "agent_not_found"].includes(closed?.error?.code);
    if (!closureAccepted) {
      const after = herdrJson(["agent", "get", name], { allowFailure: true });
      closureAccepted = responseConfirmsAgentAbsent(after);
    }
  }
  if (!closureAccepted) {
    die(`could not confirm closure of '${name}'${tabId ? ` (${tabId})` : ""}; it was not marked stopped and its session claim was retained`);
  }

  // Ordering matters: only publish stopped after closure is confirmed. Publish
  // before releasing run exclusion so a concurrent resume cannot start and then
  // be overwritten by this stop operation.
  markStopped(name);
  const runClaim = typeof entry.sessionId === "string" ? readClaim("session", entry.sessionId) : null;
  if (runClaim?.record?.parent === parentSessionId() && !releaseClaim(runClaim)) {
    die(`'${name}' was closed and marked stopped, but its session claim could not be released at ${runClaim.path}`);
  }
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
  const entry = readRegistry({ strict: true }).children.find((c) => c.name === name);
  if (!entry) {
    console.log(`'${name}' was not in this session's registry`);
    return;
  }
  const runClaim = typeof entry.sessionId === "string" ? readClaim("session", entry.sessionId) : null;
  if (runClaim) die(`'${name}' still has an unresolved session claim at ${runClaim.path}; stop it before forgetting ownership`);
  const nameClaim = ensureOwnedNameClaim(entry);
  if (!nameClaim || !releaseClaim(nameClaim)) {
    die(`could not release name ownership for '${name}'${nameClaim?.path ? ` at ${nameClaim.path}` : ""}`);
  }
  // Release first: while the legacy registry entry remains, other parents still
  // refuse the name. If registry persistence now fails, retry can safely
  // reacquire the claim instead of leaving an ownerless orphan claim on disk.
  const forgotten = forgetChild(name);
  console.log(forgotten ? `forgot ${name}` : `'${name}' was not in this session's registry`);
}

/**
 * Re-register a live Herdr agent this session already owns by name claim. The
 * gap it closes: a spawn whose process was killed between claiming the name and
 * recording the child, which left a running child that `list`, `result` and
 * `stop` all denied existed. Ownership is the claim, never the tab, so this
 * cannot be used to seize another session's child.
 */
function cmdAdopt(name, opts = {}) {
  requireHerdr();
  const claim = readClaim("name", name);
  const existing = readRegistry().children.find((c) => c.name === name);
  const agent = confirmAgentPresent(name, opts.pane || existing?.paneId);
  if (!agent) {
    die(`'${name}' is not a live Herdr agent; there is nothing to adopt. `
      + "If Herdr never named it, pass its pane: adopt <name> --pane <pane_id> (herdr pane list)");
  }

  if (claim?.record && claim.record.parent !== parentSessionId()) {
    die(`'${name}' is claimed by parent session ${claim.record.parent}; refusing to adopt another session's child`);
  }
  if (!claim && !existing) {
    die(`'${name}' carries no ownership claim from this session, so it was not launched here. `
      + `Close it with: herdr tab close ${agent.tab_id || "<tab_id>"}`);
  }

  const sessionId = agent.agent_session?.value || existing?.sessionId || claim?.record?.sessionId;
  if (!sessionId) die(`Herdr reports no Claude session id for '${name}' yet; retry once it is detected`);
  if (existing?.sessionId && existing.sessionId !== sessionId) {
    die(`'${name}' is running session ${sessionId}, but this session owns ${existing.sessionId}; `
      + "that tab is not the child we launched");
  }
  const role = opts.role || existing?.role;
  if (!role) die("adopt needs --role <name> when there is no registry entry to read it from");
  requireRole(role);

  const { startupUncertain, launchError, stoppedAt, ...kept } = existing || {};
  const entry = {
    ...kept,
    name, sessionId, role,
    cwd: agent.cwd || kept.cwd || process.cwd(),
    tabId: agent.tab_id || kept.tabId || null,
    paneId: agent.pane_id || kept.paneId || null,
    workspace: agent.workspace_id || kept.workspace || callerWorkspace(),
    parent: parentSessionId(),
    startedAt: kept.startedAt || new Date().toISOString(),
    adoptedAt: new Date().toISOString(),
  };
  if (!claim) claimNewName(name, sessionId); // best effort; the entry is the record
  claimSessionRun(entry); // no-op when the killed spawn already claimed it
  upsertChild(entry);
  console.log(JSON.stringify({
    ...entry,
    status: agent.agent_status,
    next: Array.isArray(entry.argv)
      ? `adopted; list/result/stop/resume now see "${name}".`
      : `adopted; list/result/stop now see "${name}". No recorded argv, so it cannot be resumed `
        + "after a stop - read its answer with 'hs.mjs result' first.",
  }, null, 2));
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

function shimPath() {
  return join(homedir(), ".claude", "herdr-subagents", "hs.mjs");
}

/**
 * SKILL.md has to name a path that a model can run verbatim, on any machine,
 * with no lookup step first. It cannot name this checkout (machine-specific)
 * and it cannot resolve its own location: the skill loads from ~/.claude/skills
 * where CLAUDE_PLUGIN_ROOT is unset, and that entry is a junction whose ".."
 * resolves lexically to ~/.claude rather than to the plugin. A fixed shim under
 * $HOME is the only address that is both stable and portable.
 */
const SHIM_MARKER = "// Generated by 'hs.mjs install' - do not edit.";

function shimBody() {
  const target = fwd(join(PLUGIN_DIR, "scripts", "hs.mjs"));
  return [
    "#!/usr/bin/env node",
    `${SHIM_MARKER} Forwards to the plugin checkout.`,
    'import { existsSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    "const target = " + JSON.stringify(target) + ";",
    "if (!existsSync(target)) {",
    '  console.error("hs: plugin gone from " + target + " - re-run install from the plugin checkout");',
    "  process.exit(1);",
    "}",
    "globalThis.__HS_EXPLICIT_SHIM__ = true;",
    "const { main } = await import(pathToFileURL(target).href);",
    "delete globalThis.__HS_EXPLICIT_SHIM__;",
    "await main(process.argv.slice(2));",
    "",
  ].join("\n");
}

function pathEntryExists(path) {
  try { lstatSync(path); return true; }
  catch { return false; }
}

function shimOwnership() {
  const p = shimPath();
  let stat;
  try { stat = lstatSync(p); }
  catch { return { kind: "missing", body: null }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { kind: "foreign", body: null };
  const body = readFileSync(p, "utf8");
  if (body === shimBody()) return { kind: "current", body };
  if (body.includes(SHIM_MARKER)) {
    return { kind: "generated", body };
  }
  return { kind: "foreign", body };
}

function writeShim({ quiet = false } = {}) {
  const p = shimPath();
  const state = shimOwnership();
  if (state.kind === "current") return false;
  if (state.kind === "foreign") {
    die(`${p} already exists and is not a shim generated by hs.mjs; refusing to overwrite it`);
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, shimBody());
  if (!quiet) console.log("shim: " + p + " -> " + fwd(join(PLUGIN_DIR, "scripts", "hs.mjs")));
  return true;
}

/**
 * A plugin directory under ~/.claude/skills/<name> auto-loads for every session
 * as <name>@skills-dir, so a link there is the whole install.
 */
function installLink() {
  return join(homedir(), ".claude", "skills", "herdr-subagents");
}

// Claude Code loads ~/.claude/skills/<name>/SKILL.md. Linking the plugin ROOT
// there buries SKILL.md at skills/herdr-subagents/SKILL.md, two levels too deep,
// so the skill silently never loads - the link exists and nothing works.
function skillSource() {
  return join(PLUGIN_DIR, "skills", "herdr-subagents");
}

// Loose .md files in ~/.claude/commands each become a slash command. The command
// bodies carry a "<plugin>" placeholder because they are also read as plugin
// commands, where CLAUDE_PLUGIN_ROOT is set; a deployed copy has to spell the
// path out. Marked so uninstall only ever removes what install wrote.
const COMMAND_MARKER = "<!-- deployed by hs.mjs; edits belong in the plugin repo -->";

function commandTargets() {
  const dir = join(PLUGIN_DIR, "commands");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      name: f,
      source: join(dir, f),
      dest: join(homedir(), ".claude", "commands", f),
    }));
}

function deployCommands() {
  const done = [];
  for (const c of commandTargets()) {
    // Forward slashes: the placeholder is always followed by /scripts/..., and node
    // and both shells accept them on Windows, so this avoids a mixed-separator path.
    const root = PLUGIN_DIR.split("\\").join("/");
    const body = readFileSync(c.source, "utf8").split("<plugin>").join(root);
    mkdirSync(dirname(c.dest), { recursive: true });
    if (existsSync(c.dest) && !readFileSync(c.dest, "utf8").includes(COMMAND_MARKER)) {
      console.log(`skipped ${c.dest} (not ours - remove it by hand to deploy)`);
      continue;
    }
    writeFileSync(c.dest, `${body.trimEnd()}

${COMMAND_MARKER}
`);
    done.push(c.name.replace(/\.md$/, ""));
  }
  return done;
}

function linkTarget(path) {
  try {
    return lstatSync(path).isSymbolicLink()
      ? resolve(dirname(path), readlinkSync(path))
      : null;
  } catch {
    return null;
  }
}

function cmdInstall() {
  const link = installLink();
  const want = skillSource();
  if (!existsSync(want)) die(`no skill to install at ${want}`);
  const target = linkTarget(link);
  // Validate both owned surfaces before changing either one. A foreign shim or
  // skill must not turn install into a partial takeover.
  if (pathEntryExists(link) && target !== want && target !== PLUGIN_DIR) {
    die(`${link} already exists${target ? ` (points at ${target})` : ""}; remove it first`);
  }
  if (shimOwnership().kind === "foreign") {
    die(`${shimPath()} already exists and is not a shim generated by hs.mjs; refusing to overwrite it`);
  }
  if (target === want) {
    console.log(`already installed: ${link} -> ${target}`);
  } else if (target === PLUGIN_DIR) {
    // Repair the pre-2026-08-26 layout, which linked the plugin root and so
    // never surfaced the skill at all.
    rmSync(link, { recursive: false, force: true });
    symlinkSync(want, link, process.platform === "win32" ? "junction" : "dir");
    console.log(`repaired: ${link} -> ${want} (was the plugin root, so the skill never loaded)`);
  } else if (pathEntryExists(link)) {
    die(`${link} already exists${target ? ` (points at ${target})` : ""}; remove it first`);
  } else {
    mkdirSync(dirname(link), { recursive: true });
    // "junction" is the only link type Windows grants without elevation.
    symlinkSync(want, link, process.platform === "win32" ? "junction" : "dir");
    console.log(`installed: ${link} -> ${want}`);
  }
  if (!writeShim()) console.log(`shim: ${shimPath()} (already current)`);
  const deployed = deployCommands();
  console.log(deployed.length ? `commands: ${deployed.map((d) => `/${d}`).join(" ")}` : "commands: none");
  console.log("Restart Claude Code to pick up the skill and commands.");
}

function cmdUninstall() {
  const link = installLink();
  const target = linkTarget(link);
  let found = false;
  if (target === skillSource() || target === PLUGIN_DIR) {
    found = true;
    rmSync(link, { recursive: false, force: true });
    console.log(`removed ${link}`);
  } else if (pathEntryExists(link)) {
    found = true;
    console.log(`skipped ${link} (not ours${target ? `; points at ${target}` : ""})`);
  }

  const shim = shimOwnership();
  if (shim.kind === "current" || shim.kind === "generated") {
    found = true;
    rmSync(shimPath(), { force: true });
    console.log(`removed ${shimPath()}`);
  } else if (shim.kind === "foreign") {
    found = true;
    console.log(`skipped ${shimPath()} (not ours)`);
  }

  for (const c of commandTargets()) {
    if (existsSync(c.dest) && readFileSync(c.dest, "utf8").includes(COMMAND_MARKER)) {
      found = true;
      rmSync(c.dest, { force: true });
      console.log(`removed ${c.dest}`);
    }
  }
  if (!found) console.log("not installed");
}

/**
 * The one check that would have caught the field failures: every static check
 * stayed green through a session where four spawns in five reported a startup
 * that had in fact happened. Time a real one instead of asserting around it.
 */
function probeSpawn(check) {
  const cli = fileURLToPath(new URL("./hs.mjs", import.meta.url));
  const name = `hs-doctor-${randomUUID().slice(0, 6)}`;
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  const startedAt = Date.now();
  const spawned = run(["spawn", "--role", "scout", "--model", "haiku", "--name", name]);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  let status = null;
  try { status = JSON.parse(spawned.stdout).status; } catch { /* reported below */ }

  if (spawned.status === 0 && status && status !== "starting") {
    check(true, `real spawn detected in ${seconds}s (budget ${AGENT_START_TIMEOUT_MS} ms)`);
  } else if (spawned.status === 0) {
    check(false, `real spawn launched but undetected after ${seconds}s `
      + `(budget ${AGENT_START_TIMEOUT_MS} ms; raise HS_AGENT_START_TIMEOUT_MS)`);
  } else {
    check(false, `real spawn failed after ${seconds}s: `
      + `${(spawned.stderr || spawned.stdout || "").trim().split(/\r?\n/)[0] || "no output"}`);
  }
  const stopped = run(["stop", name]);
  run(["forget", name]);
  if (stopped.status !== 0) {
    console.log(`note  probe child '${name}' may still be open: ${(stopped.stderr || "").trim()}`);
  }
}

function cmdDoctor(opts = {}) {
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
  // Assert the skill is LOADABLE, not merely that a link exists: the old layout
  // linked the plugin root, which passes an existence check and loads nothing.
  const loadable = existsSync(join(installLink(), "SKILL.md"));
  console.log(
    `${loadable ? "ok  " : "note"}  ${loadable
      ? `skill loadable at ${installLink()}`
      : "skill NOT loadable by the orchestrator (run: hs.mjs install) - spawning still works"}`,
  );
  const shimCurrent = shimOwnership().kind === "current";
  console.log(
    `${shimCurrent ? "ok  " : "note"}  ${shimCurrent
      ? `shim current (${shimPath()})`
      : `shim stale or missing at ${shimPath()} (spawn rewrites it; or run: hs.mjs install)`}`,
  );
  check(Boolean(replyAddress()), "children can address this session (reply address set)");
  const missing = commandTargets().filter((c) => !existsSync(c.dest)).map((c) => c.name);
  console.log(
    `${missing.length ? "note" : "ok  "}  ${missing.length
      ? `commands not deployed: ${missing.join(", ")} (run: hs.mjs install)`
      : `commands deployed (${commandTargets().length})`}`,
  );
  const roles = discoverRoles();
  check(roles.size > 0, `roles discovered (${[...roles.keys()].join(", ") || "none"})`);
  console.log(`note  startup detection budget ${AGENT_START_TIMEOUT_MS} ms`
    + ` (HS_AGENT_START_TIMEOUT_MS, or --startup-timeout per spawn)`);

  try {
    writeRegistry(readRegistry());
    check(true, `registry writable (${registryPath()})`);
  } catch (e) {
    check(false, `registry not writable: ${e.message}`);
  }

  if (opts.spawn) probeSpawn(check);
  else console.log("note  static checks only; add --spawn to time one real haiku launch");

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

function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv;
    const { opts, positional } = parseArgs(rest);

    switch (command) {
      case "spawn": cmdSpawn(opts); break;
      case "list": cmdList(opts); break;
      case "result": cmdResult(positional[0] || die("result needs a name"), opts); break;
      case "resume": cmdResume(positional[0] || die("resume needs a name"), opts); break;
      case "adopt": cmdAdopt(positional[0] || die("adopt needs a name"), opts); break;
      case "stop": cmdStop(positional[0] || die("stop needs a name")); break;
      case "stop-all": cmdStopAll(); break;
      case "forget": cmdForget(positional[0] || die("forget needs a name")); break;
      case "roles": cmdRoles(); break;
      case "install": cmdInstall(); break;
      case "uninstall": cmdUninstall(); break;
      case "doctor": cmdDoctor(opts); break;
      default:
        console.error([
          "usage: hs.mjs <command> [options]",
          "",
          "  spawn --role <name> [--task ...]   launch a child in its own tab (--help for options)",
          "  list [--json] [--all]              children this session owns; --all adds live agents it does not",
          "  result <name> [--lines N]          what a child reported",
          "  resume <name>                      reopen a stopped child with its history",
          "  adopt <name> [--role <name>]       re-register a live child this session launched",
          "  stop <name> | stop-all             close the tab; the session stays resumable",
          "  forget <name>                      drop a stopped child and free its name",
          "  roles                              available roles",
          "  install | uninstall | doctor [--spawn]",
        ].join("\n"));
        process.exitCode = 2;
    }
  } catch (error) {
    console.error(`hs: ${error?.message ?? String(error)}`);
    process.exitCode = 1;
  }
}

export {
  AGENT_START_TIMEOUT_MS,
  CALLBACK_PROMPT_PATH,
  CALLBACK_SYSTEM_PROMPT,
  discoverRoles,
  ensureCallbackPrompt,
  lastAssistantMessage,
  main,
  parseArgs,
  parseFrontmatter,
  sanitizeName,
  validateCallbackRole,
};
