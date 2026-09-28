# Changelog

## 1.3.0 - 2026-09-27

- Set hive defaults once in `~/.hive/hive.yml`. Any key you put there applies to every project, and a project's own `hive.yml` overrides it key by key. `hive doctor` shows where each setting came from (global or project). `hive lead`, `hive setup` and `hive doctor` fold an existing `~/.hive/config.json` into the new file and keep a copy of the original.
- A new `/hive:profile` skill in the Claude Code plugin interviews you about how you work with agents, then creates a hive profile or edits one you already have. It recommends the simple or orchestration profile from your answers, can draw your flows as a Mermaid diagram, and offers recipes for common problems such as two test runs sharing one database.
- `agent_spawn` takes `read_only: true`. The worker cannot write files or run mutating shell commands, but it can still use hive's tools, so it can write a plan to a pad. It suits planning or review workers. Only an effort flag may be passed alongside it, and `agent_resume` keeps the mode.
- `agent_resume` restores the model and extra arguments a worker was spawned with, instead of starting it on the defaults.
- A codex worker's hive MCP server now receives the worker's hive identity and data directory. Before this, a codex worker in a directory outside its project could register a new project, or write to the default store when you ran hive with a different one.
- Nested codex runs inside a hive codex worker, such as `codex exec`, can call hive's tools. Every codex home hive generates now pre-approves hive's own MCP tools, so the call no longer fails with "approval policy is never".
- Every hive tool declares MCP tool annotations (read-only, destructive, idempotent, open-world), so clients can see what a tool does before calling it.
- A migration that fails for a reason other than a busy store now names the failing migration and the SQL error. It no longer tells you to look for a stuck hive process.
- An idle wake that was ready when its worker went idle, but was held past its max wait (for example while your pane showed a dialog), is no longer labelled "max wait reached".
- `review_tags` is retired. A `hive.yml` that still sets it gets a warning asking you to remove it, and nothing else changes.

## 1.2.2 - 2026-09-24

- The build-changed notice now reaches Claude Code. Claude Code shows the model only the structured part of a tool result for tools that declare an output schema, so the notice that 1.2.0 added as extra text was hidden, and the lead wake was the only place it appeared. The notice now also rides in the result as an optional `hive_notice` string. The same fix applies to the notice hive gives when it registers a new project for your working directory.
- hive describes itself the same way everywhere: the README, the npm package, `hive --help` and the MCP help now say "Run a crew of Claude Code and Codex workers from one lead session". CONTRIBUTING.md now says which harnesses hive supports and why.

## 1.2.1 - 2026-09-24

- A running hive session now picks up a repaired build stamp. If the stamp file on disk was unreadable and you fixed its permissions, the build-changed notice used to keep reporting it as unreadable until you restarted the session. It now reads the stamp again.

## 1.2.0 - 2026-09-23

- `hive upgrade` updates hive in one command. On a global npm install it installs the latest `@cmgmyr/hive`, re-pins the `hive` command using the new install's own setup, and prints the exact fix for any Claude Code or Codex MCP registration that still points at the old install. It never edits those tools' config files. In a git checkout it prints the pull, install, build and setup steps, and runs them only with `hive upgrade --run`. `hive upgrade --check` previews without changing your install.
- `hive --version --check` asks npm for the latest published version and tells you whether you are current. `hive --version` and `hive doctor` then show an update line when a newer version exists. `hive doctor` refreshes that answer itself at most once a day, and only in an interactive terminal. This is the one network request hive makes, always through your own `npm`, never from the MCP server, hooks or scheduler. Set `HIVE_NO_UPDATE_CHECK=1` to turn it off.
- A running hive session now notices when the hive build on disk has changed since it started, after a rebuild or an upgrade. The next hive tool result says which build it loaded and which is on disk, and a lead also gets one wake with the same sentence. Restart that session, or reconnect hive in `/mcp`, to pick up the new build. Sessions started before 1.2.0 cannot notice anything, so restart every hive session once after upgrading to 1.2.0.
- `hive init` writes commented `agents:` and `dashboard:` examples, and `hive.example.yml` and the docs now list every top-level `hive.yml` key.

## 1.1.0 - 2026-09-23

- `hive doctor` warns when your shared store's schema is ahead of this build, which means a newer hive has already migrated it. `hive statusline` shows `store ahead (update hive)` in the same case. Upgrade that install before you rely on it. The warning does not change `hive doctor --strict`'s exit code.
- `hive statusline` can show a lead how many turns its session has taken. Pipe Claude Code's statusline JSON to it, for example `printf '%s' "$input" | hive statusline`, and a lead's line gains `turns N`. Set `lead_turn_budget: {warn: 300, stop: 600}` in `hive.yml` to colour it amber and red at your own thresholds. Workers never show it.
- `agent_list` pages its closed-agent listing: newest first, 20 by default and at most 100, with a `before_id` cursor for the next page. A long-lived project no longer returns hundreds of closed workers in one call.
- The README demo shows the whole loop: finished workers stay on screen as idle, and the lead asks what to work on next.
- Every Mermaid diagram in the docs renders, and CI now checks that they do.

## 1.0.0 - 2026-09-22

The first public release of hive, a local MCP server and CLI for shared memory and visible worker sessions.

- Run Claude Code and Codex workers together on one project.
- Nothing leaves your machine: no daemon, no network, one SQLite file.

Install it globally with `npm install -g @cmgmyr/hive`.
