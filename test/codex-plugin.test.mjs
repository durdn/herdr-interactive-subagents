import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("Codex plugin", () => {
  it("declares a skills-only plugin rooted at the repository", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "herdr-interactive-subagents");
    assert.equal(manifest.skills, "./skills/");
    assert.equal(manifest.version, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
    assert.equal(Object.hasOwn(manifest, "hooks"), false);
  });

  it("ships a focused orchestration skill and every generated role reference", () => {
    const skill = readFileSync(join(ROOT, "skills", "herdr-subagents", "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /\[TODO:/);
    assert.match(skill, /Codex's native collaboration runtime/);
    assert.match(skill, /not independent terminal processes/);
    assert.match(skill, /native mailbox wait operation/);

    for (const name of ["scout", "researcher", "worker", "reviewer"]) {
      const rolePath = join(ROOT, "skills", "herdr-subagents", "references", `${name}.md`);
      assert.equal(existsSync(rolePath), true, `missing Codex role reference ${name}`);
      const role = readFileSync(rolePath, "utf8");
      assert.match(role, new RegExp(`name: ${name}`));
      assert.match(role, /## Result requirements/);
    }
  });

  it("does not claim that native Codex children occupy separate Herdr tabs", () => {
    const skill = readFileSync(join(ROOT, "skills", "herdr-subagents", "SKILL.md"), "utf8");
    assert.match(skill, /does not show one Herdr tab per native child/);
    assert.match(skill, /Do not launch unrelated `codex` CLI sessions/);
  });
});
