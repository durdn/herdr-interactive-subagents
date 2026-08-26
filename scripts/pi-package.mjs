import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2] ?? "doctor";
const pluginRoot = resolve(
  process.env.HERDR_PLUGIN_ROOT || fileURLToPath(new URL("..", import.meta.url)),
);

function run(bin, args, options = {}) {
  // Node cannot execute Windows .cmd shims with shell:false. Keep shell
  // interpretation constrained to cmd.exe's pi.cmd dispatch; all Unix calls
  // and the Herdr .exe remain direct argv launches.
  const actualBin = process.platform === "win32" && bin === "pi" ? "cmd.exe" : bin;
  const actualArgs = process.platform === "win32" && bin === "pi"
    ? ["/d", "/c", "pi.cmd", ...args]
    : args;
  const result = spawnSync(actualBin, actualArgs, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) process.exit(result.status ?? 1);
  return result;
}

if (command === "install") {
  console.log(`Installing pi package from ${pluginRoot}`);
  run("pi", ["install", pluginRoot]);
  console.log("Installed. Restart pi (or run /reload) inside Herdr before spawning subagents.");
} else if (command === "remove") {
  console.log(`Removing pi package ${pluginRoot}`);
  run("pi", ["remove", pluginRoot]);
} else if (command === "doctor") {
  let failed = false;
  const check = (ok, message) => {
    console.log(`${ok ? "ok" : "FAIL"}  ${message}`);
    failed ||= !ok;
  };

  check(process.env.HERDR_ENV === "1", "running in a Herdr plugin context");
  check(Boolean(process.env.HERDR_WORKSPACE_ID), "workspace context is available");
  check(Boolean(process.env.HERDR_BIN_PATH), "HERDR_BIN_PATH is available");

  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  const version = run(herdr, ["--version"], { capture: true, allowFailure: true });
  check(version.status === 0, version.stdout?.trim() || "Herdr CLI is callable");

  const piList = run("pi", ["list"], { capture: true, allowFailure: true });
  const packageListed = piList.status === 0 && piList.stdout.includes(pluginRoot);
  check(packageListed, `pi package is installed from ${pluginRoot}`);

  if (!packageListed) {
    console.log(
      "Run: herdr plugin action invoke durdn.interactive-subagents.install-pi",
    );
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
