import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  codexPermissionArgs,
  normalizePermissionProfile,
  parseArgs,
} from "../skills/herdr-subagents/scripts/codex-subagents.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "skills", "herdr-subagents", "scripts", "codex-subagents.mjs");
const FAKE_HERDR = join(ROOT, "test", "fixtures", "fake-herdr.mjs");

function fixture(profile = ":danger-full-access") {
  const root = mkdtempSync(join(tmpdir(), "codex-herdr-test-"));
  const project = join(root, "project");
  mkdirSync(project);
  const state = join(root, "state.json");
  const log = join(root, "herdr.log");
  const env = {
    ...process.env,
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w-test",
    HERDR_PANE_ID: "w-test:p0",
    HERDR_BIN_PATH: FAKE_HERDR,
    CODEX_SESSION_ID: "parent-codex-session",
    CODEX_PERMISSION_PROFILE: profile,
    HCS_REGISTRY_ROOT: join(root, "registry"),
    HCS_DISABLE_WATCHER: "1",
    HCS_SKIP_WINDOWS_CODEX_EXE: "1",
    HCS_SHELL_READY_DELAY_MS: "0",
    HS_FAKE_STATE: state,
    HS_FAKE_LOG: log,
    HS_FAKE_WORKSPACE: "w-test",
    HS_FAKE_PARENT_PANE: "w-test:p0",
  };
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: project,
    env,
    encoding: "utf8",
  });
  const calls = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
  return { root, project, run, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("Codex plugin", () => {
  it("declares a skills-only plugin rooted at the repository", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "herdr-interactive-subagents");
    assert.equal(manifest.skills, "./skills/");
    assert.equal(manifest.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
    assert.equal(Object.hasOwn(manifest, "hooks"), false);
  });

  it("ships a visible-tab skill, lifecycle launcher, and every generated role", () => {
    const skill = readFileSync(join(ROOT, "skills", "herdr-subagents", "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /\[TODO:/);
    assert.match(skill, /full Codex session in a background tab/);
    assert.match(skill, /codex-subagents\.mjs spawn/);
    assert.match(skill, /CODEX_PERMISSION_PROFILE/);
    assert.match(skill, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(skill, /<herdr-subagent-event>/);
    assert.equal(existsSync(SCRIPT), true);

    for (const name of ["scout", "researcher", "worker", "reviewer"]) {
      const rolePath = join(ROOT, "skills", "herdr-subagents", "references", `${name}.md`);
      assert.equal(existsSync(rolePath), true, `missing Codex role reference ${name}`);
      const role = readFileSync(rolePath, "utf8");
      assert.match(role, new RegExp(`name: ${name}`));
      assert.match(role, /## Result requirements/);
    }
  });

  it("maps the leader's live permission profile to explicit child CLI boundaries", () => {
    assert.equal(normalizePermissionProfile("danger-full-access"), ":danger-full-access");
    assert.deepEqual(
      codexPermissionArgs(":danger-full-access").args,
      ["--dangerously-bypass-approvals-and-sandbox"],
    );
    assert.deepEqual(
      codexPermissionArgs(":workspace").args,
      ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
    );
    assert.deepEqual(
      codexPermissionArgs(":read-only").args,
      ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
    );
    assert.deepEqual(
      codexPermissionArgs("team-profile").args,
      ["-c", 'default_permissions="team-profile"'],
    );
  });

  it("parses repeated command options without executing on import", () => {
    assert.deepEqual(parseArgs(["--task", "one", "--task", "two", "name"]), {
      opts: { task: ["one", "two"] },
      positional: ["name"],
    });
  });

  it("creates a Herdr tab, launches Codex with full access, prompts it, and owns cleanup", () => {
    const fx = fixture();
    try {
      const spawned = fx.run([
        "spawn", "--role", "scout", "--name", "visible-scout",
        "--cwd", fx.project, "--task", "Map the code and report paths.",
      ]);
      assert.equal(spawned.status, 0, spawned.stderr);
      const entry = JSON.parse(spawned.stdout);
      assert.equal(entry.name, "visible-scout");
      assert.equal(entry.tabId, "w-test:t1");
      assert.equal(entry.paneId, "w-test:p1");
      assert.equal(entry.permissionProfile, ":danger-full-access");
      assert.equal(entry.briefPaths.length, 1);
      assert.match(readFileSync(entry.briefPaths[0], "utf8"), /Map the code and report paths\./);
      assert.match(readFileSync(entry.briefPaths[0], "utf8"), /You are a scout/);

      const calls = fx.calls();
      const tab = calls.find((call) => call[0] === "tab" && call[1] === "create");
      assert.ok(tab);
      assert.deepEqual(tab.slice(0, 8), [
        "tab", "create", "--workspace", "w-test", "--cwd", fx.project,
        "--label", "visible-scout",
      ]);
      const start = calls.find((call) => call[0] === "agent" && call[1] === "start");
      assert.ok(start);
      assert.equal(start[start.indexOf("--kind") + 1], "codex");
      const childArgs = start.slice(start.indexOf("--") + 1);
      assert.ok(childArgs.includes("--dangerously-bypass-approvals-and-sandbox"));
      assert.ok(childArgs.includes("--no-alt-screen"));
      assert.ok(childArgs.includes("gpt-5.6-terra"));
      assert.ok(childArgs.includes('model_reasoning_effort="low"'));
      const prompt = calls.find((call) => call[0] === "agent" && call[1] === "prompt");
      assert.match(prompt[3], /^Read the complete task brief at /);
      assert.ok(prompt[3].length < 500, "Herdr should submit a short prompt, not bracketed-paste the full brief");
      assert.ok(prompt.includes("--wait"));

      const listed = fx.run(["list", "--json"]);
      assert.equal(listed.status, 0, listed.stderr);
      assert.equal(JSON.parse(listed.stdout)[0].status, "done");

      const result = fx.run(["result", "visible-scout", "--wait"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /fake child screen/);

      const stopped = fx.run(["stop", "visible-scout"]);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /stopped visible-scout \(w-test:t1\)/);
      const close = fx.calls().find((call) => call[0] === "tab" && call[1] === "close");
      assert.deepEqual(close, ["tab", "close", "w-test:t1"]);
    } finally {
      fx.cleanup();
    }
  });

  it("resumes a stopped child in a new visible tab with its retained Codex session", () => {
    const fx = fixture();
    try {
      assert.equal(fx.run([
        "spawn", "--role", "worker", "--name", "resume-worker",
        "--cwd", fx.project, "--task", "Return a result.",
      ]).status, 0);
      assert.equal(fx.run(["result", "resume-worker", "--wait"]).status, 0);
      assert.equal(fx.run(["stop", "resume-worker"]).status, 0);

      const resumed = fx.run(["resume", "resume-worker", "--task", "Now provide a follow-up."]);
      assert.equal(resumed.status, 0, resumed.stderr);
      const calls = fx.calls();
      const starts = calls.filter((call) => call[0] === "agent" && call[1] === "start");
      assert.equal(starts.length, 2);
      const childArgs = starts[1].slice(starts[1].indexOf("--") + 1);
      assert.ok(childArgs.includes("resume"));
      assert.ok(childArgs.includes("fake-codex-session"));
      assert.equal(calls.filter((call) => call[0] === "tab" && call[1] === "create").length, 2);
    } finally {
      fx.cleanup();
    }
  });

  it("submits completion callbacks to the parent with an observed-state handshake", () => {
    const fx = fixture();
    try {
      assert.equal(fx.run([
        "spawn", "--role", "scout", "--name", "callback-scout",
        "--cwd", fx.project, "--task", "Inspect only.",
      ]).status, 0);
      const watched = fx.run(["_watch", "callback-scout", "--parent-pane", "w-test:p0"]);
      assert.equal(watched.status, 0, watched.stderr);
      const callback = fx.calls().filter((call) =>
        call[0] === "agent" && call[1] === "prompt" && call[2] === "w-test:p0").at(-1);
      assert.ok(callback);
      assert.match(callback[3], /<herdr-subagent-event name="callback-scout" status="done">/);
      assert.ok(callback.includes("--wait"));
      assert.ok(callback.includes("working"));
      assert.ok(callback.includes("done"));
      assert.ok(callback.includes("blocked"));
    } finally {
      fx.cleanup();
    }
  });

  it("does not let another parent session stop an owned tab", () => {
    const fx = fixture();
    try {
      assert.equal(fx.run([
        "spawn", "--role", "scout", "--name", "owned-scout",
        "--cwd", fx.project, "--task", "Inspect only.",
      ]).status, 0);
      const foreign = spawnSync(process.execPath, [SCRIPT, "stop", "owned-scout"], {
        cwd: fx.project,
        encoding: "utf8",
        env: {
          ...process.env,
          HERDR_ENV: "1",
          HERDR_WORKSPACE_ID: "w-test",
          HERDR_PANE_ID: "w-test:p9",
          HERDR_BIN_PATH: FAKE_HERDR,
          CODEX_SESSION_ID: "different-parent",
          CODEX_PERMISSION_PROFILE: ":danger-full-access",
          HCS_REGISTRY_ROOT: join(fx.root, "registry"),
          HCS_DISABLE_WATCHER: "1",
          HCS_SKIP_WINDOWS_CODEX_EXE: "1",
          HS_FAKE_STATE: join(fx.root, "state.json"),
          HS_FAKE_LOG: join(fx.root, "herdr.log"),
        },
      });
      assert.equal(foreign.status, 1);
      assert.match(foreign.stderr, /not a Codex child owned by this parent session/);
      assert.equal(fx.calls().some((call) => call[0] === "tab" && call[1] === "close"), false);
    } finally {
      fx.cleanup();
    }
  });
});
