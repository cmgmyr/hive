# Changelog

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
