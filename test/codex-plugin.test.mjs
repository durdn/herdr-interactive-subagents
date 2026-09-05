import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  codexPermissionArgs,
  normalizePermissionProfile,
  parseArgs,
  parseCloses,
  resultKind,
} from "../skills/herdr-subagents/scripts/codex-subagents.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(ROOT, "skills", "herdr-subagents", "scripts", "codex-subagents.mjs");
const FAKE_HERDR = join(ROOT, "test", "fixtures", "fake-herdr.mjs");

function fixture(profile = ":danger-full-access", extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-herdr-test-"));
  const project = join(root, "project");
  mkdirSync(project);
  const state = join(root, "state.json");
  const log = join(root, "herdr.log");
  const codexHome = join(root, "codex-home");
  const env = {
    ...process.env,
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "w-test",
    HERDR_PANE_ID: "w-test:p0",
    HERDR_BIN_PATH: FAKE_HERDR,
    CODEX_SESSION_ID: "parent-codex-session",
    CODEX_PERMISSION_PROFILE: profile,
    CODEX_HOME: codexHome,
    HCS_REGISTRY_ROOT: join(root, "registry"),
    HCS_DISABLE_WATCHER: "1",
    HCS_SKIP_WINDOWS_CODEX_EXE: "1",
    HCS_SHELL_READY_DELAY_MS: "0",
    HS_FAKE_STATE: state,
    HS_FAKE_LOG: log,
    HS_FAKE_WORKSPACE: "w-test",
    HS_FAKE_PARENT_PANE: "w-test:p0",
    ...extraEnv,
  };
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: project,
    env,
    encoding: "utf8",
  });
  const calls = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : [];
  // The fake Herdr reports every child's session as fake-codex-session; this is its rollout.
  const transcript = (events) => {
    const directory = join(codexHome, "sessions", "2026", "09", "05");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "rollout-2026-09-05T00-00-00-fake-codex-session.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  };
  return { root, project, run, calls, transcript, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const at = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const started = (timestamp) => ({ timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } });
const completed = (timestamp, lastAgentMessage) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: lastAgentMessage },
});
const message = (timestamp, role, type, text) => ({
  timestamp,
  type: "response_item",
  payload: { type: "message", role, content: [{ type, text }] },
});
const user = (timestamp, text) => message(timestamp, "user", "input_text", text);
const assistant = (timestamp, text) => message(timestamp, "assistant", "output_text", text);
const tokens = (timestamp, total) => ({
  timestamp,
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: {
    input_tokens: total - 10, cached_input_tokens: 0, output_tokens: 10, total_tokens: total,
  } } },
});
const sleep = (ms) => spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`]);

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
    assert.match(skill, /Herdr notification/);
    assert.match(skill, /`final`/);
    assert.match(skill, /`stale`/);
    assert.match(skill, /delivery: sent/);
    assert.match(skill, /--budget-min/);
    assert.match(skill, /keeps the recorded model/);
    assert.equal(existsSync(SCRIPT), true);

    for (const name of ["general", "scout", "researcher", "worker", "reviewer"]) {
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

  it("uses the lightweight Codex default for general work", () => {
    const fx = fixture();
    try {
      const spawned = fx.run([
        "spawn", "--role", "general", "--name", "acronym-helper",
        "--cwd", fx.project, "--task", "Produce three acronyms.",
      ]);
      assert.equal(spawned.status, 0, spawned.stderr);
      const start = fx.calls().find((call) => call[0] === "agent" && call[1] === "start");
      const childArgs = start.slice(start.indexOf("--") + 1);
      assert.ok(childArgs.includes("gpt-5.6-luna"));
      assert.ok(childArgs.includes('model_reasoning_effort="low"'));
      assert.equal(JSON.parse(spawned.stdout).role, "general");
    } finally {
      fx.cleanup();
    }
  });

  it("parses repeated command options without executing on import", () => {
    assert.deepEqual(parseArgs(["--task", "one", "--task", "two", "name"]), {
      opts: { task: ["one", "two"] },
      positional: ["name"],
    });
  });

  it("reads the Closes line and types a transcript without a Herdr call", () => {
    assert.deepEqual(parseCloses("Closes: b1, b2\n\nDone."), ["b1", "b2"]);
    assert.deepEqual(parseCloses("**Closes:** b1.\nrest"), ["b1"]);
    assert.deepEqual(parseCloses("No such line"), []);
    const entry = { status: "idle", briefs: [{ id: "b1", sentAt: "2026-09-05T10:00:00.000Z", path: "x/y-b1-uuid.md" }] };
    const finished = {
      running: null,
      lastAssistant: null,
      acknowledged: { b1: "2026-09-05T10:00:05.000Z" },
      turns: [{ startedAt: "2026-09-05T10:00:01.000Z", completedAt: "2026-09-05T10:05:00.000Z", text: "Closes: b1\n\nOk" }],
    };
    assert.equal(resultKind(entry, finished).kind, "final");
    assert.equal(resultKind(entry, {
      ...finished, running: { startedAt: "2026-09-05T10:06:00.000Z" }, lastAssistant: "still going",
    }).kind, "progress");
    assert.equal(resultKind(entry, { ...finished, acknowledged: {} }).kind, "stale");
    assert.equal(resultKind({ ...entry, status: "blocked" }, finished).kind, "blocked");
    assert.equal(resultKind(entry, null).kind, "none");
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
      assert.equal(entry.briefs.length, 1);
      assert.equal(entry.briefs[0].id, "b1");
      assert.equal(entry.briefs[0].kind, "task");
      assert.equal(entry.briefs[0].delivery, "confirmed");
      const brief = readFileSync(entry.briefs[0].path, "utf8");
      assert.match(brief, /Map the code and report paths\./);
      assert.match(brief, /You are a scout/);
      assert.match(brief, /Closes: b1/);

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
      assert.match(result.stdout, /^# visible-scout: none, status done; briefs b1 confirmed/);
      assert.match(result.stdout, /fake child screen/);
      const wait = fx.calls().find((call) => call[0] === "agent" && call[1] === "wait");
      assert.ok(wait.includes("idle"), "a finished tab the user has looked at reads idle");

      const stopped = fx.run(["stop", "visible-scout"]);
      assert.equal(stopped.status, 0, stopped.stderr);
      assert.match(stopped.stdout, /stopped visible-scout \(w-test:t1\)/);
      const close = fx.calls().find((call) => call[0] === "tab" && call[1] === "close");
      assert.deepEqual(close, ["tab", "close", "w-test:t1"]);
    } finally {
      fx.cleanup();
    }
  });

  it("types the transcript: progress while a turn runs, final with the ids it closes, stale after an unanswered follow-up", () => {
    const fx = fixture();
    try {
      const spawned = fx.run([
        "spawn", "--role", "scout", "--name", "typed-scout",
        "--cwd", fx.project, "--task", "Map the module.",
      ]);
      assert.equal(spawned.status, 0, spawned.stderr);
      const briefFile = basename(JSON.parse(spawned.stdout).briefs[0].path);
      const turn = [
        started(at(0)),
        user(at(10), `Read the complete task brief at C:/tmp/briefs/${briefFile} and follow it.`),
        assistant(at(20), "Mapping the module."),
        tokens(at(25), 1200),
      ];
      fx.transcript(turn);
      let result = JSON.parse(fx.run(["result", "typed-scout", "--json"]).stdout);
      assert.equal(result.kind, "progress");
      assert.equal(result.text, "Mapping the module.");
      assert.ok(result.briefs[0].acknowledgedAt, "the transcript's user message is the receipt");
      assert.equal(result.usage.totalTokens, 1200);
      assert.equal(result.source, "transcript");

      fx.transcript([...turn, completed(at(30), "Closes: b1\n\nThree paths found.")]);
      result = JSON.parse(fx.run(["result", "typed-scout", "--json"]).stdout);
      assert.equal(result.kind, "final");
      assert.deepEqual(result.closes, ["b1"]);
      assert.equal(result.text, "Closes: b1\n\nThree paths found.");
      const plain = fx.run(["result", "typed-scout"]);
      assert.match(plain.stdout, /^# typed-scout: final, status done; closes b1; briefs b1 acknowledged\n/);

      sleep(30);
      const followUp = fx.run(["message", "typed-scout", "--message", "Also the logout path."]);
      assert.equal(followUp.status, 0, followUp.stderr);
      const sent = JSON.parse(followUp.stdout);
      assert.deepEqual(sent.brief, { id: "b2", amends: ["b1"], delivery: "confirmed" });
      const prompts = fx.calls().filter((call) => call[0] === "agent" && call[1] === "prompt");
      assert.match(prompts[1][3], /^Read follow-up b2 at .* which stands\.$/);
      const listed = JSON.parse(fx.run(["list", "--json"]).stdout)[0];
      const followUpBrief = readFileSync(listed.briefs[1].path, "utf8");
      assert.match(followUpBrief, /# Follow-up b2 to your assignment/);
      assert.match(followUpBrief, /Your assignment \(b1\) stands/);
      assert.match(followUpBrief, /Closes: b1, b2/);

      result = JSON.parse(fx.run(["result", "typed-scout", "--json"]).stdout);
      assert.equal(result.kind, "stale", "the last finished turn predates b2");
      assert.equal(result.briefs[1].acknowledgedAt, null);
      assert.deepEqual(result.closes, []);
    } finally {
      fx.cleanup();
    }
  });

  it("queues a follow-up behind a working turn and reports it sent, not timed out", () => {
    const fx = fixture(":danger-full-access", { HS_FAKE_PROMPT_STATUS: "working" });
    try {
      const spawned = fx.run([
        "spawn", "--role", "worker", "--name", "busy-worker",
        "--cwd", fx.project, "--task", "Implement the change.",
      ]);
      assert.equal(spawned.status, 0, spawned.stderr);
      assert.equal(JSON.parse(spawned.stdout).status, "working");
      const followUp = fx.run(["message", "busy-worker", "--message", "Also add a test."]);
      assert.equal(followUp.status, 0, followUp.stderr);
      const sent = JSON.parse(followUp.stdout);
      assert.equal(sent.brief.delivery, "sent");
      assert.match(sent.next, /queued behind the running turn/);
      const prompts = fx.calls().filter((call) => call[0] === "agent" && call[1] === "prompt");
      assert.equal(prompts.length, 2);
      assert.ok(prompts[0].includes("--wait"));
      assert.equal(prompts[1].includes("--wait"), false, "a working child shows no state change to wait for");
      const listed = JSON.parse(fx.run(["list", "--json"]).stdout)[0];
      assert.equal(listed.briefs.length, 2);
      assert.equal(listed.briefs[1].delivery, "sent");
      assert.equal(listed.kind, "none");
    } finally {
      fx.cleanup();
    }
  });

  it("refuses a message to a blocked child before typing anything", () => {
    const fx = fixture(":danger-full-access", { HS_FAKE_PROMPT_STATUS: "blocked" });
    try {
      assert.equal(fx.run([
        "spawn", "--role", "scout", "--name", "asking-scout",
        "--cwd", fx.project, "--task", "Inspect only.",
      ]).status, 0);
      const refused = fx.run(["message", "asking-scout", "--message", "Carry on."]);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /'asking-scout' is blocked: an approval or question is open in its tab; nothing was sent/);
      assert.equal(fx.calls().filter((call) => call[0] === "agent" && call[1] === "prompt").length, 1);
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
      const entry = JSON.parse(resumed.stdout);
      assert.equal(entry.briefs.at(-1).id, "b2");
      assert.equal(entry.briefs.at(-1).kind, "follow-up");
    } finally {
      fx.cleanup();
    }
  });

  it("resumes on the recorded model and reasoning unless a flag overrides them", () => {
    const fx = fixture();
    try {
      assert.equal(fx.run([
        "spawn", "--role", "reviewer", "--name", "astra-review", "--cwd", fx.project,
        "--model", "gpt-6-astra", "--reasoning", "high", "--task", "Review the state design.",
      ]).status, 0);
      assert.equal(fx.run(["stop", "astra-review"]).status, 0);

      const resumed = fx.run(["resume", "astra-review"]);
      assert.equal(resumed.status, 0, resumed.stderr);
      let starts = fx.calls().filter((call) => call[0] === "agent" && call[1] === "start");
      let childArgs = starts[1].slice(starts[1].indexOf("--") + 1);
      assert.ok(childArgs.includes("gpt-6-astra"), "the role default must not replace the recorded model");
      assert.ok(childArgs.includes('model_reasoning_effort="high"'));
      let entry = JSON.parse(resumed.stdout);
      assert.equal(entry.modelSource, "recorded");
      assert.deepEqual(entry.notes, []);

      assert.equal(fx.run(["stop", "astra-review"]).status, 0);
      const overridden = fx.run(["resume", "astra-review", "--model", "gpt-5.6-sol"]);
      assert.equal(overridden.status, 0, overridden.stderr);
      starts = fx.calls().filter((call) => call[0] === "agent" && call[1] === "start");
      childArgs = starts[2].slice(starts[2].indexOf("--") + 1);
      assert.ok(childArgs.includes("gpt-5.6-sol"));
      entry = JSON.parse(overridden.stdout);
      assert.equal(entry.modelSource, "override");
      assert.deepEqual(entry.notes, ["model override gpt-5.6-sol replaces recorded gpt-6-astra"]);
    } finally {
      fx.cleanup();
    }
  });

  it("records a budget, flags the child past it, and has the watcher say so", () => {
    const fx = fixture(":danger-full-access", { HS_FAKE_PROMPT_STATUS: "working" });
    try {
      const spawned = fx.run([
        "spawn", "--role", "worker", "--name", "slow-worker", "--cwd", fx.project,
        "--budget-min", "0.001", "--task", "Take too long.",
      ]);
      assert.equal(spawned.status, 0, spawned.stderr);
      const entry = JSON.parse(spawned.stdout);
      assert.equal(entry.budgetMin, 0.001);
      assert.ok(entry.deadline);
      sleep(120);
      const listed = fx.run(["list", "--json"]);
      assert.equal(JSON.parse(listed.stdout)[0].overBudget, true);
      assert.match(fx.run(["list"]).stdout, /slow-worker.*working.*0!/);

      const watched = fx.run(["_watch", "slow-worker"]);
      assert.equal(watched.status, 0, watched.stderr);
      const wait = fx.calls().filter((call) => call[0] === "agent" && call[1] === "wait").at(-1);
      assert.ok(wait.includes("--timeout"), "the watcher waits no longer than the budget");
      const notification = fx.calls().filter((call) => call[0] === "notification" && call[1] === "show").at(-1);
      assert.equal(notification[2], "Herdr agent over budget");
      assert.match(notification[notification.indexOf("--body") + 1], /slow-worker is still working past its 0.001 min budget/);

      const rejected = fx.run([
        "spawn", "--role", "worker", "--name", "no-budget", "--cwd", fx.project,
        "--budget-min", "0", "--task", "x",
      ]);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stderr, /--budget-min needs a positive number of minutes/);
    } finally {
      fx.cleanup();
    }
  });

  it("shows completion through Herdr without injecting a prompt into the parent", () => {
    const fx = fixture();
    try {
      assert.equal(fx.run([
        "spawn", "--role", "scout", "--name", "notification-scout",
        "--cwd", fx.project, "--task", "Inspect only.",
      ]).status, 0);
      const watched = fx.run(["_watch", "notification-scout"]);
      assert.equal(watched.status, 0, watched.stderr);
      const notification = fx.calls().filter((call) =>
        call[0] === "notification" && call[1] === "show").at(-1);
      assert.ok(notification);
      assert.equal(notification[2], "Herdr agent finished");
      assert.match(notification[notification.indexOf("--body") + 1], /notification-scout is done/);
      assert.equal(notification[notification.indexOf("--sound") + 1], "done");
      assert.equal(fx.calls().some((call) =>
        call[0] === "agent" && call[1] === "prompt" && call[2] === "w-test:p0"), false);
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
