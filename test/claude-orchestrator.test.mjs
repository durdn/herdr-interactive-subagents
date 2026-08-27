import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import {
  CALLBACK_PROMPT_PATH,
  CALLBACK_SYSTEM_PROMPT,
  ensureCallbackPrompt,
  parseArgs,
  parseFrontmatter,
  sanitizeName,
} from "../claude-plugin/scripts/hs-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "claude-plugin", "scripts", "hs.mjs");
const LIB = join(ROOT, "claude-plugin", "scripts", "hs-lib.mjs");
const FAKE_HERDR = join(ROOT, "test", "fixtures", "fake-herdr.mjs");
const temporary = new Set();

afterEach(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
  temporary.clear();
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hs-test-"));
  temporary.add(dir);
  const home = join(dir, "home");
  const project = join(dir, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const log = join(dir, "herdr.log");
  const state = join(dir, "herdr-state.json");
  return {
    dir, home, project, log, state,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "w-env",
      CLAUDE_CODE_SESSION_ID: "parent-test",
      CLAUDE_CODE_MESSAGING_SOCKET: "uds:\\\\.\\pipe\\parent-test",
      CLAUDE_PLUGIN_ROOT: join(ROOT, "claude-plugin"),
      HERDR_BIN_PATH: FAKE_HERDR,
      HS_FAKE_LOG: log,
      HS_FAKE_STATE: state,
      HS_SHELL_READY_DELAY_MS: "1",
      HS_SHELL_READY_TIMEOUT_MS: "1000",
    },
  };
}

function run(fx, args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd || fx.project,
    env: { ...fx.env, ...options.env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runAsync(fx, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd || fx.project,
      env: { ...fx.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

function ok(result) {
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  return result;
}

function calls(fx) {
  if (!existsSync(fx.log)) return [];
  return readFileSync(fx.log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function registryPath(fx) {
  return join(fx.home, ".claude", "herdr-subagents", "parent-test", "registry.json");
}

function registry(fx) {
  return JSON.parse(readFileSync(registryPath(fx), "utf8"));
}

function startArgs(fx, occurrence = 0) {
  const call = calls(fx).filter((args) => args[0] === "agent" && args[1] === "start")[occurrence];
  assert.ok(call, "expected fake Herdr agent start call");
  return call.slice(call.indexOf("--") + 1);
}

function addRole(fx, name, tools = "Read, SendMessage", extra = "") {
  const dir = join(fx.project, ".claude", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), [
    "---", `name: ${name}`, `description: ${name} fixture`, `tools: ${tools}`,
    "model: haiku", "effort: low", extra, "---", "Return the requested fixture result.", "",
  ].filter(Boolean).join("\n"));
}

describe("Claude orchestrator pure contracts", () => {
  it("parses frontmatter, repeated options, and names without process side effects", () => {
    assert.deepEqual(parseFrontmatter("---\r\nName: Demo\r\ntools: Read, SendMessage\r\n---\r\nBody\r\n"), {
      fields: { name: "Demo", tools: "Read, SendMessage" }, body: "Body",
    });
    assert.deepEqual(parseFrontmatter("---\ntools:\n  - Read\n  - SendMessage\ndisallowedTools: [Bash]\n---\nBody\n"), {
      fields: { tools: "Read, SendMessage", disallowedtools: "[Bash]" }, body: "Body",
    });
    assert.deepEqual(parseArgs(["--add-dir", "a", "--add-dir", "b", "tail"]), {
      opts: { addDir: ["a", "b"] }, positional: ["tail"],
    });
    assert.equal(sanitizeName(" 9 Hello, Windows! "), "a9-hello-windows");
    assert.equal(sanitizeName("---"), "a");
  });

  it("keeps one current authoritative callback prompt", () => {
    const old = ["--name", "x", "--append-system-prompt", "old", "--model", "sonnet"];
    const next = ensureCallbackPrompt(old);
    assert.deepEqual(next.slice(0, 4), ["--name", "x", "--model", "sonnet"]);
    assert.equal(next.filter((arg) => arg === "--append-system-prompt-file").length, 1);
    assert.equal(next.at(-1).replaceAll("\\", "/"), CALLBACK_PROMPT_PATH.replaceAll("\\", "/"));
    assert.match(CALLBACK_SYSTEM_PROMPT, /task brief/);
    assert.match(CALLBACK_SYSTEM_PROMPT, /cross-session message/);
    assert.match(CALLBACK_SYSTEM_PROMPT, /resumed session/);
    assert.match(CALLBACK_SYSTEM_PROMPT, /`SendMessage` exactly once/);
  });

  it("keeps bundled role bodies role-specific and transport-free", () => {
    for (const name of ["scout", "researcher", "reviewer", "worker"]) {
      const text = readFileSync(join(ROOT, "claude-plugin", "agents", `${name}.md`), "utf8");
      const body = parseFrontmatter(text).body;
      assert.doesNotMatch(body, /SendMessage|Reply address|cross-session-message|progress chatter/);
      assert.match(body, /Result requirements/);
      assert.match(parseFrontmatter(text).fields.tools, /SendMessage/);
    }
  });

  it("imports both implementation and CLI entrypoint without running a command", () => {
    const fx = fixture();
    const code = `await import(${JSON.stringify(pathToFileURL(LIB).href)}); await import(${JSON.stringify(pathToFileURL(CLI).href)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: fx.project, env: fx.env, encoding: "utf8",
    });
    ok(result);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(calls(fx), []);
    assert.equal(existsSync(registryPath(fx)), false);
  });
});

describe("Claude orchestrator no-model CLI", { concurrency: false }, () => {
  it("discovers bundled roles and project roles with preserved output", () => {
    const fx = fixture();
    addRole(fx, "fixture-role");
    const result = ok(run(fx, ["roles"]));
    assert.match(result.stdout, /^ROLE\s+MODEL\s+EFFORT\s+DESCRIPTION/m);
    assert.match(result.stdout, /fixture-role\s+haiku\s+low\s+fixture-role fixture/);
    assert.match(result.stdout, /scout\s+sonnet\s+low/);
    assert.deepEqual(calls(fx), []);
  });

  it("spawns a one-step bundled role with seed first, callback, brief, and unchanged registry schema", () => {
    const fx = fixture();
    const extra = join(fx.dir, "extra space");
    mkdirSync(extra);
    const result = ok(run(fx, [
      "spawn", "--role", "scout", "--name", "Map Auth", "--cwd", fx.project,
      "--add-dir", extra, "--task", "Map auth.\nInclude paths.",
    ], { env: { HS_FAKE_BUSY_ONCE: "1" } }));
    const output = JSON.parse(result.stdout);
    assert.equal(output.name, "map-auth");
    assert.equal(output.workspace, "w-test");
    assert.equal(output.status, "idle");
    assert.match(output.next, /reports back on its own/);

    const argv = startArgs(fx, 1);
    assert.match(argv[0], /^Read .+\/briefs\/map-auth\.md and carry out/);
    assert.equal(argv[1], "--name");
    assert.equal(argv[argv.indexOf("--agent") + 1], "scout");
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "auto");
    assert.equal(argv[argv.indexOf("--settings") + 1], '{"crossSessionInbound":"accept"}');
    assert.equal(
      argv[argv.indexOf("--append-system-prompt-file") + 1],
      CALLBACK_PROMPT_PATH.replaceAll("\\", "/"),
    );
    assert.ok(argv.includes(resolve(extra)));

    const brief = readFileSync(output.brief, "utf8");
    assert.match(brief, /Reply address: uds:\\\\.\\pipe\\parent-test/);
    assert.match(brief, /Map auth\.\nInclude paths\./);
    assert.doesNotMatch(brief, /SendMessage|progress chatter/);

    const child = registry(fx).children[0];
    assert.deepEqual(Object.keys(child), [
      "name", "sessionId", "role", "cwd", "tabId", "paneId", "workspace", "model",
      "effort", "parent", "startedAt", "argv",
    ]);
    assert.equal(child.argv[0], "--name");
    assert.equal(child.argv.includes(argv[0]), false, "seed must not enter resumable argv");
  });

  it("spawns taskless/two-step and compatible custom roles without requiring a parent inbox", () => {
    const fx = fixture();
    addRole(fx, "custom-ok", "\n  - Read\n  - SendMessage");
    const result = ok(run(fx, [
      "spawn", "--role", "custom-ok", "--name", "standing", "--cwd", fx.project,
    ], { env: { CLAUDE_CODE_MESSAGING_SOCKET: "" } }));
    const output = JSON.parse(result.stdout);
    assert.equal(output.brief, null);
    assert.match(output.next, /idle - send the task with SendMessage/);
    const argv = startArgs(fx);
    assert.equal(argv[0], "--name", "taskless launch must have no positional seed");
    assert.equal(argv[argv.indexOf("--agent") + 1], "custom-ok");
    assert.equal(
      argv[argv.indexOf("--append-system-prompt-file") + 1],
      CALLBACK_PROMPT_PATH.replaceAll("\\", "/"),
    );
  });

  it("rejects callback-incompatible roles and launch options before Herdr mutation", () => {
    for (const mode of [
      "missing-tool", "empty-tools", "denied-tool", "denied-glob", "bypass",
      "bad-permission", "missing-address", "bad-effort", "missing-add-dir", "missing-name",
    ]) {
      const fx = fixture();
      const tools = mode === "missing-tool" ? "Read, Grep"
        : mode === "empty-tools" ? "" : "Read, SendMessage";
      const extra = mode === "denied-tool" ? "disallowedTools: SendMessage"
        : mode === "denied-glob" ? 'disallowedTools: "Send*"' : "";
      addRole(fx, mode, tools, extra);
      const args = ["spawn", "--role", mode, "--cwd", fx.project];
      const env = {};
      if (mode === "bypass") args.push("--permission-mode", "bypassPermissions");
      if (mode === "bad-permission") args.push("--permission-mode", "unattended");
      if (mode === "missing-address") {
        args.push("--task", "needs callback");
        env.CLAUDE_CODE_MESSAGING_SOCKET = "";
      }
      if (mode === "bad-effort") args.push("--effort", "extreme");
      if (mode === "missing-add-dir") args.push("--add-dir", join(fx.dir, "missing"));
      if (mode === "missing-name") args.push("--name");
      const result = run(fx, args, { env });
      assert.equal(result.status, 1, `${mode}: ${result.stdout} ${result.stderr}`);
      assert.match(result.stderr, /^hs: /);
      assert.equal(calls(fx).some((call) => call[0] === "tab" && call[1] === "create"), false);
    }
  });

  it("fails closed when Herdr reports startup may have begun", () => {
    const fx = fixture();
    const result = run(fx, [
      "spawn", "--role", "scout", "--name", "broken", "--cwd", fx.project,
    ], { env: { HS_FAKE_START_FAILURE: "1" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start 'broken'; tab w-test:t1 closed/);
    assert.match(result.stderr, /Ownership retained for diagnosis/);
    assert.ok(calls(fx).some((call) => call[0] === "agent" && call[1] === "read"));
    assert.ok(calls(fx).some((call) => call[0] === "tab" && call[1] === "close"));
    const child = registry(fx).children[0];
    assert.equal(child.name, "broken");
    assert.equal(child.startupUncertain, true);
    assert.ok(existsSync(child.ownershipClaim));
    assert.ok(existsSync(child.sessionClaim));

    const duplicate = run(fx, [
      "spawn", "--role", "scout", "--name", "broken", "--cwd", fx.project,
    ]);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /explicit name 'broken' is already owned/);
  });

  it("rolls back claims when pane-busy proves startup never began", () => {
    const fx = fixture();
    const failed = run(fx, [
      "spawn", "--role", "scout", "--name", "retryable", "--cwd", fx.project,
    ], { env: {
      HS_FAKE_START_BUSY_ALWAYS: "1",
      HS_SHELL_READY_TIMEOUT_MS: "5",
    } });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /could not start 'retryable'/);
    assert.equal(existsSync(registryPath(fx)), false);

    const retried = ok(run(fx, [
      "spawn", "--role", "scout", "--name", "retryable", "--cwd", fx.project,
    ]));
    assert.equal(JSON.parse(retried.stdout).name, "retryable");
  });

  it("atomically rejects concurrent explicit-name spawns before duplicate Herdr mutation", async () => {
    const fx = fixture();
    const args = ["spawn", "--role", "scout", "--name", "one-owner", "--cwd", fx.project];
    const results = await Promise.all([runAsync(fx, args), runAsync(fx, args)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [0, 1]);
    assert.match(results.find((r) => r.status === 1).stderr, /explicit name 'one-owner' is already owned/);
    assert.equal(calls(fx).filter((call) => call[0] === "tab" && call[1] === "create").length, 1);
    assert.equal(registry(fx).children.length, 1);
  });

  it("lists live/stopped state, keeps stop resumable, resumes without replaying the seed, then forgets", () => {
    const fx = fixture();
    ok(run(fx, ["spawn", "--role", "worker", "--name", "job", "--cwd", fx.project, "--task", "Do it"]));
    const first = registry(fx).children[0];
    let result = ok(run(fx, ["list", "--json"]));
    assert.equal(JSON.parse(result.stdout)[0].status, "idle");

    result = ok(run(fx, ["stop", "job"]));
    assert.match(result.stdout, /resumable/);
    assert.ok(registry(fx).children[0].stoppedAt);
    result = ok(run(fx, ["list", "--json"]));
    assert.equal(JSON.parse(result.stdout)[0].status, "stopped");

    result = ok(run(fx, ["resume", "job"]));
    assert.deepEqual(JSON.parse(result.stdout), {
      name: "job", sessionId: first.sessionId, tabId: "w-test:t2", paneId: "w-test:p2", status: "resumed",
    });
    const resumedArgs = startArgs(fx, 1);
    assert.deepEqual(resumedArgs.slice(0, 2), ["--resume", first.sessionId]);
    assert.equal(resumedArgs.includes("--session-id"), false);
    assert.equal(resumedArgs.some((arg) => /^Read .+briefs/.test(arg)), false);
    assert.equal(resumedArgs.filter((arg) => arg === "--append-system-prompt-file").length, 1);
    assert.equal(
      resumedArgs[resumedArgs.indexOf("--append-system-prompt-file") + 1],
      CALLBACK_PROMPT_PATH.replaceAll("\\", "/"),
    );
    assert.equal(registry(fx).children[0].stoppedAt, undefined);

    ok(run(fx, ["stop", "job"]));
    result = ok(run(fx, ["forget", "job"]));
    assert.match(result.stdout, /forgot job/);
    assert.deepEqual(registry(fx).children, []);
  });

  it("atomically excludes concurrent resumes of one Claude transcript", async () => {
    const fx = fixture();
    ok(run(fx, ["spawn", "--role", "worker", "--name", "resume-race", "--cwd", fx.project]));
    ok(run(fx, ["stop", "resume-race"]));

    const results = await Promise.all([
      runAsync(fx, ["resume", "resume-race"]),
      runAsync(fx, ["resume", "resume-race"]),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [0, 1]);
    assert.match(results.find((r) => r.status === 1).stderr, /already claimed.*refusing to run one transcript twice/);
    const resumeStarts = calls(fx).filter((args) =>
      args[0] === "agent" && args[1] === "start" && args.includes("--resume"));
    assert.equal(resumeStarts.length, 1);
  });

  it("does not mark stopped or release resume exclusion when closure is unconfirmed", () => {
    const fx = fixture();
    ok(run(fx, ["spawn", "--role", "worker", "--name", "close-fails", "--cwd", fx.project]));
    const stopped = run(fx, ["stop", "close-fails"], { env: {
      HS_FAKE_CLOSE_FAILURE: "1",
      HS_FAKE_GET_FAILURE: "1",
    } });
    assert.equal(stopped.status, 1);
    assert.match(stopped.stderr, /could not confirm closure/);
    assert.equal(registry(fx).children[0].stoppedAt, undefined);

    const resumed = run(fx, ["resume", "close-fails"]);
    assert.equal(resumed.status, 1);
    assert.match(resumed.stderr, /still live|already claimed/);
  });

  it("rejects malformed resume state before Herdr mutation", () => {
    const fx = fixture();
    mkdirSync(dirname(registryPath(fx)), { recursive: true });
    writeFileSync(registryPath(fx), JSON.stringify({ children: [{
      name: "broken", sessionId: "not-a-session", role: "scout", cwd: fx.project,
      argv: ["--name", 42],
    }] }));
    const result = run(fx, ["resume", "broken"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /incomplete registry entry/);
    assert.equal(calls(fx).some((call) => call[0] === "tab" && call[1] === "create"), false);
  });

  it("upgrades a legacy registry argv to the callback contract on resume", () => {
    const fx = fixture();
    mkdirSync(dirname(registryPath(fx)), { recursive: true });
    writeFileSync(registryPath(fx), JSON.stringify({ children: [{
      name: "legacy", sessionId: "12345678-1234-1234-1234-123456789012", role: "scout",
      cwd: fx.project, tabId: "old", paneId: "old", workspace: "w-test", stoppedAt: "then",
      argv: ["--name", "legacy", "--session-id", "12345678-1234-1234-1234-123456789012",
        "--permission-mode", "auto", "--agent", "scout"],
    }] }));
    ok(run(fx, ["resume", "legacy"]));
    const argv = startArgs(fx);
    assert.equal(
      argv[argv.indexOf("--append-system-prompt-file") + 1],
      CALLBACK_PROMPT_PATH.replaceAll("\\", "/"),
    );
    assert.equal(
      registry(fx).children[0].argv.at(-1),
      CALLBACK_PROMPT_PATH.replaceAll("\\", "/"),
    );
  });

  it("prefers the last SendMessage result over trailing transcript text and supports --lines", () => {
    const fx = fixture();
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    mkdirSync(dirname(registryPath(fx)), { recursive: true });
    writeFileSync(registryPath(fx), JSON.stringify({ children: [{ name: "done", sessionId }] }));
    const transcriptDir = join(fx.home, ".claude", "projects", "windows-path-slug");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "draft" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SendMessage", input: { message: "line one\nline two" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "trailing local text" }] } }),
    ].join("\n"));
    const result = ok(run(fx, ["result", "done", "--lines", "1"]));
    assert.equal(result.stdout.trim(), "line two");
    assert.deepEqual(calls(fx), []);
  });

  it("keeps legacy shims callable, installs the current shim, and uninstalls owned files", () => {
    const fx = fixture();
    const shim = join(fx.home, ".claude", "herdr-subagents", "hs.mjs");
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, [
      "#!/usr/bin/env node",
      `const target = ${JSON.stringify(CLI.replaceAll("\\", "/"))};`,
      'await import("file:///" + target);',
      "",
    ].join("\n"));
    let result = spawnSync(process.execPath, [shim, "roles"], {
      cwd: fx.project, env: fx.env, encoding: "utf8",
    });
    ok(result);
    assert.match(result.stdout, /scout/);

    result = ok(run(fx, ["install"]));
    assert.ok(existsSync(shim));
    assert.match(readFileSync(shim, "utf8"), /__HS_EXPLICIT_SHIM__/);
    assert.match(readFileSync(shim, "utf8"), /const \{ main \} = await import/);
    assert.match(readFileSync(shim, "utf8"), /pathToFileURL\(target\)\.href/);
    assert.ok(existsSync(join(fx.home, ".claude", "skills", "herdr-subagents", "SKILL.md")));
    assert.ok(existsSync(join(fx.home, ".claude", "commands", "subagent.md")));

    result = spawnSync(process.execPath, [shim, "roles"], {
      cwd: fx.project, env: fx.env, encoding: "utf8",
    });
    ok(result);
    assert.match(result.stdout, /scout/);

    ok(run(fx, ["uninstall"]));
    assert.equal(existsSync(shim), false);
    assert.equal(existsSync(join(fx.home, ".claude", "skills", "herdr-subagents")), false);
    assert.equal(existsSync(join(fx.home, ".claude", "commands", "subagent.md")), false);
  });

  it("ships both import-safe script modules in the npm package", () => {
    const localNpm = process.env.npm_execpath
      || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const hasNodeCli = existsSync(localNpm);
    const result = spawnSync(hasNodeCli ? process.execPath : "npm", [
      ...(hasNodeCli ? [localNpm] : []), "pack", "--dry-run", "--json",
    ], {
      cwd: ROOT, encoding: "utf8", shell: !hasNodeCli && process.platform === "win32",
    });
    ok(result);
    const pack = JSON.parse(result.stdout)[0];
    const names = pack.files.map((file) => file.path.replaceAll("\\", "/"));
    assert.ok(names.includes("claude-plugin/scripts/hs.mjs"));
    assert.ok(names.includes("claude-plugin/scripts/hs-lib.mjs"));
    assert.ok(names.includes("claude-plugin/callback-prompt.md"));
    assert.equal(names.some((name) => name === "brief.txt" || name.startsWith("test/")), false);
  });
});
