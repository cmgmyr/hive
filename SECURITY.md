# Security

See [What hive can do on your machine](docs/security.md) for a code-cited list of network access, commands, file writes, and process model.

hive runs only on your machine. It has no daemon. The CLI queries npm for hive's latest version on an explicit `hive --version --check`, a global `hive upgrade`, or an interactive stale-cache doctor refresh. An upgrade can also download software: global installs run `npm install -g @cmgmyr/hive@latest`; checkouts run `git pull --ff-only` and `npm install` only with `hive upgrade --run`. `HIVE_NO_UPDATE_CHECK=1` disables the version query, but does not prevent downloads from an explicitly run checkout upgrade. A global upgrade stops before installing when the flag disables its version query. The MCP server, hooks, and scheduler make no outbound requests. See [What hive can do on your machine](docs/security.md) for code references and the full list.

## What to know

- Commands in a project's `hive.yml` run only after you approve them once, interactively. Any change to a command, its `dir` or its `env` requires approval again. `dir` cannot escape the project root.
- `vars` in `hive.yml` reach the lead's system prompt and every worker's brief with no approval gate. Treat a cloned repo's `hive.yml` the way you treat its `CLAUDE.md`.

## Reporting a problem

Open a [GitHub issue](https://github.com/cmgmyr/hive/issues). Use GitHub's private vulnerability reporting instead once it is enabled for this repository, and keep exploit details out of a public issue until then.
