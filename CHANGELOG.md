# Changelog

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
