// Herdr surface layer for interactive subagents.
//
// Each surface is the root pane of a dedicated tab in the orchestrator's
// current Herdr workspace. The pane id remains the handle used by the rest of
// the extension; this module remembers the owning tab so cleanup closes the
// whole subagent tab rather than leaving an empty shell behind.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

function herdrBin(): string {
  return process.env.HERDR_BIN_PATH?.trim() || "herdr";
}

function runHerdr(args: string[]): string {
  return execFileSync(herdrBin(), args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function runHerdrAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(herdrBin(), args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function runHerdrJson(args: string[]): any {
  const output = runHerdr(args).trim();
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Unexpected Herdr response for ${args.join(" ")}: ${output || "(empty output)"}`,
      { cause: error },
    );
  }
}

// ── Availability ────────────────────────────────────────────────────────────

let availabilityCache: boolean | undefined;

function callerWorkspaceId(): string {
  const response = runHerdrJson(["pane", "current", "--current"]);
  const workspaceId = response?.result?.pane?.workspace_id;
  if (typeof workspaceId !== "string") {
    throw new Error(`Herdr did not resolve the caller workspace: ${JSON.stringify(response)}`);
  }
  return workspaceId;
}

/** True only in a Herdr-managed pane connected to a live Herdr server. */
export function isHerdrAvailable(): boolean {
  if (
    process.env.HERDR_ENV !== "1" ||
    !process.env.HERDR_WORKSPACE_ID ||
    !process.env.HERDR_PANE_ID
  ) {
    return false;
  }
  if (availabilityCache !== undefined) return availabilityCache;

  try {
    callerWorkspaceId();
    availabilityCache = true;
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

/** Backwards-compatible generic name used by the extension. */
export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return (
    "Start pi inside Herdr, then install Herdr's Pi integration " +
    "(`herdr integration install pi`)."
  );
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ───────────────────────────────────────────────────────────

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Tab surfaces ────────────────────────────────────────────────────────────

/** Root pane id -> owning tab id for tabs created by this process. */
const surfaceTabs = new Map<string, string>();

function tabIdForSurface(surface: string): string | null {
  const known = surfaceTabs.get(surface);
  if (known) return known;

  try {
    const response = runHerdrJson(["pane", "get", surface]);
    const tabId = response?.result?.pane?.tab_id;
    return typeof tabId === "string" ? tabId : null;
  } catch {
    return null;
  }
}

/** Test and harness helper: return the Herdr tab containing a surface. */
export function getSurfaceTabId(surface: string): string | null {
  return tabIdForSurface(surface);
}

/**
 * Create a background tab in the caller's workspace and return its root pane.
 * Explicit workspace targeting is essential: CLI focus may belong to another
 * client, while HERDR_WORKSPACE_ID always identifies the orchestrator's space.
 */
export function createSurface(name: string, cwd = process.cwd()): string {
  requireHerdr();
  // Resolve through --current instead of trusting launch-time workspace env:
  // Herdr keeps inherited ids stable when a live pane is moved, while this
  // query returns the pane's authoritative current workspace.
  const workspaceId = callerWorkspaceId();
  const args = [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--cwd",
    cwd,
    "--label",
    name || "subagent",
    "--no-focus",
  ];
  const response = runHerdrJson(args);
  const paneId = response?.result?.root_pane?.pane_id;
  const tabId = response?.result?.tab?.tab_id;
  if (typeof paneId !== "string" || typeof tabId !== "string") {
    throw new Error(`Herdr tab creation did not return tab/root pane ids: ${JSON.stringify(response)}`);
  }
  const tabWorkspaceId = response?.result?.tab?.workspace_id;
  const paneWorkspaceId = response?.result?.root_pane?.workspace_id;
  if (tabWorkspaceId !== workspaceId || paneWorkspaceId !== workspaceId) {
    // Treat public ids as opaque and verify the authoritative workspace fields
    // returned by Herdr instead of deriving topology from id spelling.
    try {
      runHerdr(["tab", "close", tabId]);
    } catch {}
    throw new Error(
      `Herdr created subagent surface outside workspace ${workspaceId}: ` +
      `tab workspace=${tabWorkspaceId}, pane workspace=${paneWorkspaceId}`,
    );
  }

  surfaceTabs.set(paneId, tabId);
  return paneId;
}

/**
 * Legacy compatibility for callers/tests that requested split directions.
 * Herdr subagents intentionally use tabs, so direction and source are ignored.
 */
export function createSurfaceSplit(
  name: string,
  _direction: "left" | "right" | "up" | "down",
  _fromSurface?: string,
  cwd = process.cwd(),
): string {
  return createSurface(name, cwd);
}

/** Atomically submit a shell command in the tab's root pane. */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  runHerdr(["pane", "run", surface, command]);
}

/**
 * Persist a long launch command for debugging, then execute that script in the
 * surface. Herdr's pane.run transports the invocation atomically.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "herdr-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptParts.push(options.scriptPreamble.trimEnd());
  scriptParts.push(command);
  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });

  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/** Read recent unwrapped terminal output. */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return runHerdr([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

/** Read recent unwrapped terminal output asynchronously. */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  return runHerdrAsync([
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
  ]);
}

/** Close the whole tab created for this subagent. */
export function closeSurface(surface: string): void {
  requireHerdr();
  const tabId = tabIdForSurface(surface);
  if (!tabId) throw new Error(`Cannot resolve Herdr tab for subagent pane ${surface}`);
  runHerdr(["tab", "close", tabId]);
  surfaceTabs.delete(surface);
}

/** Harness helper for focus-preservation tests. */
export function focusSurface(surface: string): void {
  requireHerdr();
  const tabId = tabIdForSurface(surface);
  if (!tabId) throw new Error(`Cannot resolve Herdr tab for pane ${surface}`);
  runHerdr(["tab", "focus", tabId]);
}

/** Return the UI-focused pane (not the CLI process's inherited caller pane). */
export function getFocusedSurface(): string | null {
  requireHerdr();
  try {
    const response = runHerdrJson([
      "pane",
      "list",
      "--workspace",
      callerWorkspaceId(),
    ]);
    const panes = response?.result?.panes;
    if (!Array.isArray(panes)) return null;
    const focused = panes.find((pane: any) => pane?.focused === true);
    return typeof focused?.pane_id === "string" ? focused.pane_id : null;
  } catch {
    return null;
  }
}

// ── Exit polling ────────────────────────────────────────────────────────────

export interface PollResult {
  reason: "done" | "sentinel" | "error";
  exitCode: number;
  errorMessage?: string;
}

function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Pi's lifecycle sidecars provide the fast path;
 * the terminal sentinel catches clean completion and process crashes.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");

    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
      } catch {}
    }

    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) return { reason: "sentinel", exitCode: Number.parseInt(match[1], 10) };
    } catch {
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    options.onTick?.(Math.floor((Date.now() - start) / 1000));

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
