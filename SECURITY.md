# Security

hive runs only on your machine. It has no daemon and makes no network calls of its own.

## What to know

- Commands in a project's `hive.yml` run only after you approve them once, interactively. Any change to a command, its `dir` or its `env` requires approval again. `dir` cannot escape the project root.
- `vars` in `hive.yml` reach the lead's system prompt and every worker's brief with no approval gate. Treat a cloned repo's `hive.yml` the way you treat its `CLAUDE.md`.

## Reporting a problem

Open a [GitHub issue](https://github.com/cmgmyr/hive/issues). Use GitHub's private vulnerability reporting instead once it is enabled for this repository, and keep exploit details out of a public issue until then.
