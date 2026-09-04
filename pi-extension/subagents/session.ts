import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/**
 * A snapshot of everything needed to reconstruct a subagent's sandbox when its
 * session is later resumed via `subagent_message({ sessionId })`.
 *
 * Written next to the session file as `<sessionFile>.loadout.json` at spawn
 * time. Resume replays this exact snapshot so the reincarnated process gets the
 * same `--no-extensions` + `--tools` restriction, model, identity, spawn
 * whitelist, cwd, and config dir it originally ran with — instead of falling
 * back to pi's default (all global extensions + full toolset). Storing the
 * resolved loadout (rather than re-deriving from the agent `.md` by name) keeps
 * resume faithful even if the agent definition is later edited, moved, or
 * deleted.
 */
export const SUBAGENT_LOADOUT_VERSION = 1 as const;

export interface SubagentLoadout {
  /** Runtime schema version for strict, fail-closed resume validation. */
  version: typeof SUBAGENT_LOADOUT_VERSION;
  /** Agent profile name (for PI_SUBAGENT_AGENT); null for agentless spawns. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when the spawn was unrestricted. */
  toolAllowlist: string | null;
  /** Model id (without thinking suffix), or null to use the session default. */
  model: string | null;
  /** Thinking level appended to the model as `model:level`, or null. */
  thinking: string | null;
  /** How the identity text was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** The system-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether the agent auto-exits (informational; resume forces autonomous). */
  autoExit: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config/extensions from, or null. */
  agentDir: string | null;
}

/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/**
 * Persist a subagent's resolved sandbox loadout beside its session file.
 *
 * This is part of the launch transaction, not a cache: without it the durable
 * name cannot safely resume after completion. Let persistence errors abort the
 * launch before any Herdr mutation instead of silently creating a dead handle.
 */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  if (!validateSubagentLoadout(loadout, false)) {
    throw new Error("Refusing to persist an invalid subagent loadout");
  }
  const p = loadoutSidecarPath(sessionFile);
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(loadout), "utf8");
    renameSync(tmp, p);
  } catch (error) {
    // writeFileSync can create a partial file before reporting an I/O failure.
    // Cover both write and rename so no unusable sidecar-shaped temp survives.
    try { rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

const LOADOUT_FIELDS = [
  "agent",
  "toolAllowlist",
  "model",
  "thinking",
  "systemPromptMode",
  "identity",
  "spawnable",
  "autoExit",
  "cwd",
  "agentDir",
] as const;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Validate both the current schema and the one safe legacy shape: the exact,
 * complete pre-version object written by this extension. Legacy data is only
 * accepted when every field proves the same runtime types and invariants as v1.
 */
function validateSubagentLoadout(
  value: unknown,
  allowLegacy: boolean,
): value is SubagentLoadout | Omit<SubagentLoadout, "version"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const hasVersion = Object.prototype.hasOwnProperty.call(record, "version");
  if (hasVersion ? record.version !== SUBAGENT_LOADOUT_VERSION : !allowLegacy) return false;

  const expected = new Set<string>([...LOADOUT_FIELDS, ...(hasVersion ? ["version"] : [])]);
  const keys = Object.keys(record);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) return false;
  if (!LOADOUT_FIELDS.every((key) => Object.prototype.hasOwnProperty.call(record, key))) return false;

  if (!isNullableString(record.agent) || !isNullableString(record.toolAllowlist)) return false;
  // applySandboxToParts intentionally treats null as unrestricted; accepting an
  // empty string here would be an accidental falsy alias and could fail open.
  if (typeof record.toolAllowlist === "string" && record.toolAllowlist.trim() === "") return false;
  if (!isNullableString(record.model) || !isNullableString(record.thinking)) return false;
  if (!isNullableString(record.identity) || !isNullableString(record.cwd)) return false;
  if (!isNullableString(record.agentDir) || typeof record.autoExit !== "boolean") return false;
  if (
    record.systemPromptMode !== null &&
    record.systemPromptMode !== "append" &&
    record.systemPromptMode !== "replace"
  ) return false;
  if (record.identity !== null && record.systemPromptMode === null) return false;

  if (record.spawnable !== null) {
    if (
      !Array.isArray(record.spawnable) ||
      record.spawnable.length === 0 ||
      record.spawnable.some((name) => typeof name !== "string" || name.trim() === "")
    ) return false;
    // A spawn whitelist without a tool allowlist could re-enable nested spawning
    // in an unrestricted process, a shape this runtime never writes.
    if (record.toolAllowlist === null) return false;
  }
  return true;
}

/** Read and strictly validate a subagent loadout snapshot, or null on any mismatch. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!validateSubagentLoadout(parsed, true)) return null;
    return Object.prototype.hasOwnProperty.call(parsed, "version")
      ? parsed as SubagentLoadout
      : { version: SUBAGENT_LOADOUT_VERSION, ...parsed } as SubagentLoadout;
  } catch {
    return null;
  }
}

// ── Name registry ────────────────────────────────────────────────────────────
// Each spawner session (the top-level pi session, or a worker that spawns its
// own children) gets a registry mapping a subagent's display name to the
// session file it ran in. Names are unique per spawner session and persist on
// disk, so `subagent_message({ name })` can steer a running subagent or resume
// a finished one by the same handle — even across a pi restart. The registry
// lives in the spawner's own artifact dir, which is directly addressable from
// the spawner's session id (no sessions-tree scan, so resume stays fast).

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file. */
  sessionFile: string;
  /** Canonical session header id (kept for display/lineage). */
  sessionId: string | null;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

export interface OwnershipClaim {
  kind: "name" | "session";
  key: string;
  token: string;
  path: string;
}

interface ClaimRecord {
  version: 1;
  kind: "name" | "session";
  key: string;
  token: string;
  pid: number;
  createdAt: string;
  name?: string;
  sessionFile?: string;
}

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

function registryLockPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.lock");
}

const REGISTRY_LOCK_LEASE_MS = 30_000;
const REGISTRY_LOCK_WAIT_MS = 5_000;
const REGISTRY_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

interface RegistryLockOwner {
  version: 1;
  token: string;
  pid: number;
  createdAt: string;
  leaseUntil: number;
}

interface HeldRegistryLock {
  path: string;
  token: string;
}

function lockProcessState(pid: unknown): "alive" | "dead" | "unknown" {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return "unknown";
  try {
    process.kill(pid as number, 0);
    return "alive";
  } catch (error: any) {
    // EPERM proves the process exists but cannot be signalled. Only ESRCH is
    // positive evidence that the owner has gone away.
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

function readRegistryLockOwner(path: string): RegistryLockOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const owner = value as Record<string, unknown>;
    if (
      owner.version !== 1 ||
      typeof owner.token !== "string" ||
      !/^[a-zA-Z0-9-]+$/.test(owner.token) ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) <= 0 ||
      typeof owner.createdAt !== "string" ||
      !Number.isFinite(owner.leaseUntil)
    ) return null;
    return owner as unknown as RegistryLockOwner;
  } catch {
    return null;
  }
}

function registryLockIsReclaimable(path: string): boolean {
  const owner = readRegistryLockOwner(path);
  if (owner) {
    if (existsSync(join(path, `released-${owner.token}`))) return true;
    const processState = lockProcessState(owner.pid);
    if (processState === "dead") return true;
    // Never evict a known-live owner based only on elapsed wall time. The lease
    // is a fallback for platforms where process liveness cannot be established.
    if (processState === "alive") return false;
    return owner.leaseUntil <= Date.now();
  }

  // mkdir and atomic owner publication are separate operations. A missing or
  // partially-written owner is only stale once the directory itself has aged
  // past the lease, avoiding takeover during that short publication window.
  try {
    return lstatSync(path).mtimeMs + REGISTRY_LOCK_LEASE_MS <= Date.now();
  } catch {
    return true;
  }
}

function reclaimRegistryLock(path: string): boolean {
  const stale = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    // Rename is the generation hand-off. Exactly one waiter can retire this
    // canonical directory, and a delayed release from its old owner cannot
    // remove a successor generation created at the canonical path.
    renameSync(path, stale);
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  try { rmSync(stale, { recursive: true, force: true }); } catch {}
  return true;
}

function acquireRegistryLock(path: string): HeldRegistryLock {
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  for (;;) {
    const token = randomUUID();
    try {
      mkdirSync(path);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      if (registryLockIsReclaimable(path) && reclaimRegistryLock(path)) continue;
      if (Date.now() >= deadline) throw error;
      Atomics.wait(REGISTRY_LOCK_SLEEP, 0, 0, 10);
      continue;
    }

    const owner: RegistryLockOwner = {
      version: 1,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      leaseUntil: Date.now() + REGISTRY_LOCK_LEASE_MS,
    };
    try {
      // `wx` prevents a creator that was suspended after mkdir from waking up
      // and overwriting a successor generation's owner record. Verify the token
      // as well: the canonical path may have been retired and recreated between
      // mkdir and this write.
      writeFileSync(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx" });
      if (readRegistryLockOwner(path)?.token === token) return { path, token };
    } catch (error: any) {
      if (!["EEXIST", "ENOENT"].includes(error?.code)) throw error;
    }
    // Never remove the canonical path here: it may already belong to a
    // successor. Retry acquisition and let lease-based recovery retire any
    // genuinely unpublished generation.
    if (Date.now() >= deadline) {
      throw new Error(`Could not publish subagent registry lock ownership at ${path}`);
    }
  }
}

function releaseRegistryLock(held: HeldRegistryLock): void {
  try {
    // Do not recursively delete the canonical path: it may already represent a
    // successor generation after stale takeover. A token marker lets the next
    // waiter retire only the generation whose owner token matches.
    writeFileSync(join(held.path, `released-${held.token}`), "", { flag: "wx" });
  } catch {
    // A stale takeover may already have moved or removed our generation.
  }
}

function withRegistryLock<T>(artifactDir: string, run: () => T): T {
  mkdirSync(artifactDir, { recursive: true });
  const held = acquireRegistryLock(registryLockPath(artifactDir));
  try {
    return run();
  } finally {
    releaseRegistryLock(held);
  }
}

function readRegistryFile(artifactDir: string, strict = false): NameRegistry {
  const p = nameRegistryPath(artifactDir);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("registry root is not an object");
    }
    return parsed as NameRegistry;
  } catch (error: any) {
    if (strict) throw new Error(`Subagent registry is corrupt at ${p}: ${error?.message ?? String(error)}`);
    return {};
  }
}

/** Read a spawner session's legacy-compatible name registry. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  return readRegistryFile(artifactDir);
}

function writeRegistryFile(artifactDir: string, registry: NameRegistry): void {
  const p = nameRegistryPath(artifactDir);
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  try {
    renameSync(tmp, p);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

/**
 * Register a name → session mapping without ever replacing another session.
 * A small directory lock prevents concurrent read/modify/write loss while the
 * JSON shape remains compatible with existing list/resume installations.
 */
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  withRegistryLock(artifactDir, () => {
    const registry = readRegistryFile(artifactDir, true);
    const existing = registry[name];
    if (existing && existing.sessionFile !== entry.sessionFile) {
      throw new Error(`Subagent name "${name}" is already registered to ${existing.sessionFile}`);
    }
    registry[name] = entry;
    writeRegistryFile(artifactDir, registry);
  });
}

/** Remove only the exact mapping installed by a launch that never began. */
export function unregisterName(
  artifactDir: string,
  name: string,
  sessionFile: string,
): void {
  withRegistryLock(artifactDir, () => {
    const registry = readRegistryFile(artifactDir, true);
    if (registry[name]?.sessionFile !== sessionFile) return;
    delete registry[name];
    writeRegistryFile(artifactDir, registry);
  });
}

function claimPath(artifactDir: string, kind: "name" | "session", key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(artifactDir, "subagent-claims", `${kind}s`, digest);
}

function tryClaim(
  artifactDir: string,
  kind: "name" | "session",
  key: string,
  details: Pick<ClaimRecord, "name" | "sessionFile">,
): OwnershipClaim | null {
  const path = claimPath(artifactDir, kind, key);
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error: any) {
    if (error?.code === "EEXIST") return null;
    throw error;
  }

  const token = randomUUID();
  const record: ClaimRecord = {
    version: 1,
    kind,
    key,
    token,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ...details,
  };
  try {
    writeFileSync(join(path, "claim.json"), JSON.stringify(record, null, 2), "utf8");
    return { kind, key, token, path };
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

/** Atomically reserve a durable child name, including names from legacy registries. */
export function tryClaimName(artifactDir: string, name: string): OwnershipClaim | null {
  if (readRegistryFile(artifactDir, true)[name]) return null;
  const claim = tryClaim(artifactDir, "name", name, { name });
  if (!claim) return null;
  // Close the migration race with an older process that registered after our first read.
  if (readRegistryFile(artifactDir, true)[name]) {
    releaseOwnershipClaim(claim);
    return null;
  }
  return claim;
}

/** Atomically exclude every other process from running the same transcript. */
export function tryClaimSession(
  artifactDir: string,
  sessionFile: string,
  name: string,
): OwnershipClaim | null {
  return tryClaim(artifactDir, "session", resolveClaimKey(sessionFile), { name, sessionFile });
}

function resolveClaimKey(path: string): string {
  // Avoid realpath: the session may not exist yet for a standalone launch.
  // Windows paths are case-insensitive, so aliases differing only by case must
  // still contend on the same transcript claim.
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Release a claim only when its unguessable token still owns the directory. */
export function releaseOwnershipClaim(claim: OwnershipClaim): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(claim.path, "claim.json"), "utf8"));
    if (parsed?.token !== claim.token || parsed?.key !== claim.key) return false;
    rmSync(claim.path, { recursive: true, force: true });
    return true;
  } catch {
    // Idempotent release is important when cancellation and its aborted watcher
    // finish concurrently. An absent directory no longer excludes anyone.
    return !existsSync(claim.path);
  }
}

/** Enumerate retained claims for diagnostics and tests. */
export function readOwnershipClaims(artifactDir: string, kind: "name" | "session"): ClaimRecord[] {
  const dir = join(artifactDir, "subagent-claims", `${kind}s`);
  if (!existsSync(dir)) return [];
  const records: ClaimRecord[] = [];
  for (const child of readdirSync(dir)) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, child, "claim.json"), "utf8"));
      if (parsed?.kind === kind && typeof parsed.key === "string") records.push(parsed);
    } catch {}
  }
  return records;
}

/** Resolve a name to its registry entry within a spawner session, or null. */
export function resolveNameInRegistry(
  artifactDir: string,
  name: string,
): NameRegistryEntry | null {
  const entry = readNameRegistry(artifactDir)[name];
  return entry && typeof entry.sessionFile === "string" ? entry : null;
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Read the canonical session id from a session file's header.
 *
 * pi's `--session <id>` flag resolves against this header `id`, not the
 * filename, so this is the value to hand back to the orchestrator.
 *
 * Read only a small prefix because session files can grow to many MB and the
 * header is always the first JSON line.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function getSessionId(sessionFile: string): string | null {
  return readHeaderId(sessionFile);
}

function readHeaderId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
/**
 * Count the number of entry lines in a session file without parsing each line
 * into an object. Used by the resume path, which only needs the *count* of
 * pre-existing entries (so it can later slice out the new ones). Parsing every
 * line of a large resumed transcript synchronously at resume time would block
 * the UI; counting newlines is dramatically cheaper.
 */
export function countSessionEntryLines(sessionFile: string): number {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    // Count non-blank lines, mirroring getNewEntries' `.filter(line => line.trim())`
    // but skipping the per-line JSON.parse that makes resume slow on big files.
    let count = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

/**
 * Parse a completed subagent session JSONL into aggregate stats for display:
 * model, tool-call count, cumulative token usage + cost, and current context
 * size. Cumulative usage fields are summed across every assistant turn; the
 * context size is taken from the last assistant turn's `totalTokens` (the live
 * context window occupancy). Returns null if the file can't be read.
 */
export function summarizeSessionStats(sessionFile: string): SessionStats | null {
  let entries: SessionEntry[];
  try {
    entries = readEntries(sessionFile);
  } catch {
    return null;
  }

  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const modelId = (entry as { modelId?: unknown }).modelId;
      if (typeof modelId === "string" && modelId) stats.model = modelId;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role !== "assistant") continue;

    const model = (msg as { model?: unknown }).model;
    if (typeof model === "string" && model) stats.model = model;

    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = (msg as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const total = num(usage.totalTokens);
      if (total > 0) stats.contextTokens = total;
      const cost = usage.cost;
      if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
    }
  }

  return stats;
}
