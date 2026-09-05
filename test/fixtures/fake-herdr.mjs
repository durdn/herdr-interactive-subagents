#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const logPath = process.env.HS_FAKE_LOG;
const statePath = process.env.HS_FAKE_STATE;
const state = statePath && existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { tabs: 0, starts: 0, live: [] };

if (logPath) appendFileSync(logPath, JSON.stringify(args) + "\n");
const save = () => { if (statePath) writeFileSync(statePath, JSON.stringify(state)); };
const json = (value, status = 0) => {
  const stream = status === 0 ? process.stdout : process.stderr;
  stream.write(JSON.stringify(value));
  save();
  process.exit(status);
};

if (args[0] === "--version") {
  console.log("herdr 0.0.0-fake");
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "current") {
  json({ result: { pane: {
    workspace_id: process.env.HS_FAKE_WORKSPACE || "w-test",
    pane_id: process.env.HS_FAKE_PARENT_PANE || "w-test:p0",
  } } });
}
if (args[0] === "agent" && args[1] === "list") {
  json({ result: { agents: state.live || [] } });
}
if (args[0] === "agent" && args[1] === "get") {
  if (process.env.HS_FAKE_GET_FAILURE === "1") {
    json({ error: { code: "server_unavailable", message: "fake get failure" } }, 1);
  }
  const agent = (state.live || []).find((item) =>
    item.name === args[2] || item.pane_id === args[2]);
  json(agent ? { result: { agent } } : { error: { code: "agent_not_found" } }, agent ? 0 : 1);
}
if (args[0] === "tab" && args[1] === "create") {
  state.tabs++;
  const id = state.tabs;
  json({ result: {
    tab: { tab_id: `w-test:t${id}` },
    root_pane: { pane_id: `w-test:p${id}` },
  } });
}
if (args[0] === "agent" && args[1] === "start") {
  state.starts++;
  if (process.env.HS_FAKE_START_BUSY_ALWAYS === "1"
    || (process.env.HS_FAKE_BUSY_ONCE === "1" && state.starts === 1)) {
    json({ error: { code: "agent_pane_busy", message: "shell is starting" } }, 1);
  }
  if (process.env.HS_FAKE_START_FAILURE === "1") {
    json({ error: { code: "agent_not_ready", message: "fake startup failure" } }, 1);
  }
  const name = args[2];
  const sessionIndex = args.indexOf("--session-id");
  const resumeIndex = args.indexOf("--resume");
  const sessionId = sessionIndex >= 0
    ? args[sessionIndex + 1]
    : resumeIndex >= 0 ? args[resumeIndex + 1] : null;
  // Herdr assigns the agent name only when a start is detected cleanly, so a
  // child that missed detection is live and nameless - reachable by pane only.
  const nameless = process.env.HS_FAKE_START_NAMELESS === "1";
  const paneId = `w-test:p${state.tabs}`;
  const agent = {
    ...(nameless ? {} : { name }),
    agent_status: "idle",
    tab_id: `w-test:t${state.tabs}`,
    pane_id: paneId,
    cwd: process.cwd(),
    workspace_id: process.env.HERDR_WORKSPACE_ID || "w-test",
    agent_session: sessionId ? { value: sessionId } : undefined,
  };
  state.live = [
    ...(state.live || []).filter((item) => item.name !== name && item.pane_id !== paneId),
    agent,
  ];
  // The field failure: Herdr's detection wait expires on a child that is in
  // fact running, so it is live in `agent list` and an error at `agent start`.
  if (nameless || process.env.HS_FAKE_START_LATE === "1") {
    json({ error: { code: "agent_not_ready", message: "fake late detection" } }, 1);
  }
  json({ result: { agent } });
}
if (args[0] === "pane" && args[1] === "get") {
  const pane = args[2] || "";
  json({ result: { pane: { pane_id: pane, tab_id: pane.replace(":p", ":t") } } });
}
if (args[0] === "pane" && args[1] === "read") {
  console.log("fake child screen");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "read") {
  console.log("fake child screen");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "prompt") {
  const agent = (state.live || []).find((item) =>
    item.name === args[2] || item.pane_id === args[2]);
  if (!agent) json({ error: { code: "agent_not_found" } }, 1);
  agent.agent_status = process.env.HS_FAKE_PROMPT_STATUS || "done";
  agent.agent_session ||= { value: "fake-codex-session" };
  json({ result: { agent, type: "agent_prompted" } });
}
if (args[0] === "agent" && args[1] === "wait") {
  const agent = (state.live || []).find((item) =>
    item.name === args[2] || item.pane_id === args[2]);
  if (!agent) json({ error: { code: "agent_not_found" } }, 1);
  json({ result: { agent, type: "agent_waited" } });
}
if (args[0] === "notification" && args[1] === "show") {
  json({ result: { type: "notification_shown", title: args[2] } });
}
if (args[0] === "tab" && args[1] === "close") {
  if (process.env.HS_FAKE_CLOSE_FAILURE === "1") {
    json({ error: { code: "tab_close_failed", message: "fake close failure" } }, 1);
  }
  state.live = [];
  json({ result: { closed: args[2] } });
}

json({ error: { code: "unexpected", message: `unexpected fake Herdr call: ${args.join(" ")}` } }, 1);
