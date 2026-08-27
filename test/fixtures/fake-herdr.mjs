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
  json({ result: { pane: { workspace_id: process.env.HS_FAKE_WORKSPACE || "w-test" } } });
}
if (args[0] === "agent" && args[1] === "list") {
  json({ result: { agents: state.live || [] } });
}
if (args[0] === "agent" && args[1] === "get") {
  const agent = (state.live || []).find((item) => item.name === args[2]);
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
  if (process.env.HS_FAKE_BUSY_ONCE === "1" && state.starts === 1) {
    json({ error: { code: "agent_pane_busy", message: "shell is starting" } }, 1);
  }
  if (process.env.HS_FAKE_START_FAILURE === "1") {
    json({ error: { code: "agent_not_ready", message: "fake startup failure" } }, 1);
  }
  const name = args[2];
  const agent = { name, agent_status: "idle", tab_id: `w-test:t${state.tabs}` };
  state.live = [...(state.live || []).filter((item) => item.name !== name), agent];
  json({ result: { agent } });
}
if (args[0] === "agent" && args[1] === "read") {
  console.log("fake child screen");
  process.exit(0);
}
if (args[0] === "tab" && args[1] === "close") {
  state.live = [];
  json({ result: { closed: args[2] } });
}

json({ error: { code: "unexpected", message: `unexpected fake Herdr call: ${args.join(" ")}` } }, 1);
