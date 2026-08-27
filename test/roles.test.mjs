import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(readFileSync(join(ROOT, "roles", "catalog.json"), "utf8"));

function fields(frontmatter) {
  return Object.fromEntries(frontmatter.split("\n").flatMap((line) => {
    const match = line.match(/^([^:#][^:]*):\s*(.*)$/);
    return match ? [[match[1].trim().toLowerCase(), match[2].trim()]] : [];
  }));
}

function role(name, adapter) {
  const found = catalog.roles.find((entry) => entry.name === name)?.adapters?.[adapter];
  assert.ok(found, `expected ${adapter} role '${name}'`);
  return { ...found, fields: fields(found.frontmatter) };
}

describe("canonical bundled role catalog", () => {
  it("has the exact adapter inventories", () => {
    assert.deepEqual(
      catalog.roles.filter((entry) => entry.adapters.pi).map((entry) => entry.name),
      ["scout", "researcher", "worker"],
    );
    assert.deepEqual(
      catalog.roles.filter((entry) => entry.adapters.claude).map((entry) => entry.name),
      ["scout", "researcher", "worker", "reviewer"],
    );
  });

  it("keeps Pi sandbox and autonomy semantics explicit", () => {
    const scout = role("scout", "pi");
    assert.deepEqual(scout.fields, {
      name: "scout",
      description: "Fast codebase recon — explores files, finds patterns, maps architecture",
      tools: "read, grep, find, ls",
      thinking: "low",
      "system-prompt": "append",
      "auto-exit": "true",
    });

    const researcher = role("researcher", "pi");
    assert.equal(researcher.fields.tools, "web_search, web_fetch");
    assert.equal(researcher.fields.thinking, "medium");
    assert.equal(researcher.fields["auto-exit"], "true");

    const worker = role("worker", "pi");
    assert.equal(worker.fields.tools, "read, write, edit, bash, web_search, web_fetch");
    assert.equal(worker.fields.subagent_agents, "scout, researcher");
    assert.equal(worker.fields.thinking, "high");
    assert.equal(worker.fields["auto-exit"], "true");
    assert.match(worker.prompt, /You may only dispatch `scout` and `researcher`/);
  });

  it("keeps Claude callback, model, effort, and reviewer semantics explicit", () => {
    for (const name of ["scout", "researcher", "worker", "reviewer"]) {
      const definition = role(name, "claude");
      assert.match(definition.fields.tools, /(?:^|, )SendMessage(?:,|$)/);
      assert.doesNotMatch(definition.prompt, /SendMessage|cross-session-message|Reply address/);
      assert.match(definition.prompt, /Result requirements/);
    }

    assert.deepEqual(
      catalog.roles.map((entry) => {
        const definition = role(entry.name, "claude");
        return [entry.name, definition.fields.model, definition.fields.effort];
      }),
      [
        ["scout", "sonnet", "low"],
        ["researcher", "sonnet", "medium"],
        ["worker", "sonnet", "high"],
        ["reviewer", "opus", "high"],
      ],
    );
    assert.match(role("reviewer", "claude").prompt, /You do not fix anything/);
  });
});
