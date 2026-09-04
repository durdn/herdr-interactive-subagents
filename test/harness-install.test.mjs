import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  codexSkillTarget,
  inspectCodexInstall,
  installCodex,
  installedPiSources,
  uninstallCodex,
} from "../scripts/harness-install.mjs";

const cleanups = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-harness-install-"));
  cleanups.push(dir);
  const root = join(dir, "checkout");
  const home = join(dir, "home");
  const source = join(root, "skills", "herdr-subagents");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: herdr-subagents\ndescription: test\n---\n");
  mkdirSync(join(source, "scripts"));
  writeFileSync(join(source, "scripts", "codex-subagents.mjs"), "// test launcher\n");
  return { dir, root, home, source };
}

describe("cross-harness installer", () => {
  it("wires every Herdr install action through the same harness installer", () => {
    const manifest = readFileSync(join(resolve(import.meta.dirname, ".."), "herdr-plugin.toml"), "utf8");
    for (const harness of ["pi", "claude", "codex"]) {
      assert.match(
        manifest,
        new RegExp(`scripts/harness-install\\.mjs\", \"install\", \"${harness}\"`),
      );
      assert.match(
        manifest,
        new RegExp(`scripts/harness-install\\.mjs\", \"uninstall\", \"${harness}\"`),
      );
    }
  });

  it("installs, checks, repeats, and removes the Codex skill without a marketplace", () => {
    const fx = fixture();
    const options = { root: fx.root, home: fx.home, env: {} };
    const target = join(fx.home, ".agents", "skills", "herdr-subagents");

    assert.equal(codexSkillTarget(options), target);
    assert.equal(inspectCodexInstall(options).installed, false);
    assert.equal(installCodex(options).installed, true);
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(resolve(dirname(target), readlinkSync(target)), fx.source);

    assert.equal(installCodex(options).installed, true, "repeat install must be idempotent");
    assert.equal(uninstallCodex(options).installed, false);
    assert.equal(existsSync(target), false);
  });

  it("refuses to overwrite or remove a foreign Codex skill", () => {
    const fx = fixture();
    const options = { root: fx.root, home: fx.home, env: {} };
    const target = codexSkillTarget(options);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "user-owned\n");

    assert.throws(() => installCodex(options), /refusing to overwrite/);
    assert.throws(() => uninstallCodex(options), /refusing to remove/);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "user-owned\n");
  });

  it("supports an explicit Codex skill-directory override", () => {
    const fx = fixture();
    const skillsDir = join(fx.dir, "managed-skills");
    const options = {
      root: fx.root,
      home: fx.home,
      env: { HERDR_CODEX_SKILLS_DIR: skillsDir },
    };
    assert.equal(codexSkillTarget(options), join(skillsDir, "herdr-subagents"));
    assert.equal(installCodex(options).installed, true);
  });

  it("resolves Pi package sources relative to its configuration directory", () => {
    const fx = fixture();
    const configDir = join(fx.home, ".pi", "agent");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      packages: ["../../dev/herdr-interactive-subagents", "git:github.com/example/other"],
    }));

    const sources = installedPiSources({ home: fx.home, env: {} });
    assert.equal(sources.length, 2);
    assert.equal(sources[0].resolved, resolve(configDir, "../../dev/herdr-interactive-subagents"));
  });
});
