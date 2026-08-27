#!/usr/bin/env node
// Thin, import-safe CLI entrypoint. The generated install shim imports main()
// explicitly, while direct execution reaches the same path below.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./hs-lib.mjs";

export { main };

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
const legacyShimPath = join(homedir(), ".claude", "herdr-subagents", "hs.mjs");
const invokedDirectly = invokedPath === fileURLToPath(import.meta.url);
const importedByLegacyShim = invokedPath === legacyShimPath && !globalThis.__HS_EXPLICIT_SHIM__;

// Pre-refactor generated shims imported this entrypoint for its side effect.
// Keep those installed shims working long enough for spawn/install to refresh
// them; every other import remains inert.
if (invokedDirectly || importedByLegacyShim) main(process.argv.slice(2));
