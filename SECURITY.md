# Security

hive runs only on your machine. It has no daemon. The CLI makes one npm registry request only when you explicitly run `hive --version --check`, or when interactive `hive doctor` refreshes a cache older than a day. The MCP server, hooks, and scheduler never make that request. Set `HIVE_NO_UPDATE_CHECK=1` to disable it.

## What to know

- Commands in a project's `hive.yml` run only after you approve them once, interactively. Any change to a command, its `dir` or its `env` requires approval again. `dir` cannot escape the project root.
- `vars` in `hive.yml` reach the lead's system prompt and every worker's brief with no approval gate. Treat a cloned repo's `hive.yml` the way you treat its `CLAUDE.md`.

## Reporting a problem

Open a [GitHub issue](https://github.com/cmgmyr/hive/issues). Use GitHub's private vulnerability reporting instead once it is enabled for this repository, and keep exploit details out of a public issue until then.
