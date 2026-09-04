# Bundled role ownership

`catalog.json` is the single canonical source for the bundled Pi, Claude, and Codex role files. Each adapter entry contains its own literal frontmatter and prompt; adapter tool names, models, effort/thinking, callback behavior, and other differences are intentionally explicit rather than translated or inferred.

Run `npm run roles:generate` after editing the catalog. This deterministically rewrites the committed files under `agents/`, `claude-plugin/agents/`, and `skills/herdr-subagents/references/`, plus only the generated table regions marked in `README.md` and both orchestrator skills. Do not edit those outputs or marked regions directly.

`npm run roles:check` is dependency-free and makes no changes. It is part of `npm test` and `prepack`; role generation never runs during install or packaging.
