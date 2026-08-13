# Projects

Setting a project up, `hive.yml`, the store's automatic backups, and reaching pads and todos from the shell.

## Runbook and board (`hive init`)

`hive init` sets a project up. It writes a starter `hive.yml`, asks which profile the project should use (or takes `--profile <name>` / `--no-profile`), and seeds the `board` pad, the live picture of the work.

A project **with** a profile reads its process from `hive runbook` and gets no runbook pad; a second copy in the store would only go stale. A project on `profile: none` gets the `runbook` pad instead, seeded with a starter template whose first-run section has the lead interview you (how work arrives, branch and PR rules, worktree setup, how workers verify, what needs explicit approval) and rewrite it to fit. Either way `hive runbook` prints the right one.

After that, opening the lead with "good morning, let's triage" is enough; every hive session is instructed to read the standing process before orchestrating. The server also exposes three playbook prompts, which Claude Code surfaces as slash commands: `/mcp__hive__triage` runs the morning ritual, `/mcp__hive__orchestrate` loads the lead/worker pattern, and `/mcp__hive__wrapup` closes the day (handoffs, worker close-out, board rotation).

The board holds today's lanes, what's waiting on you, and what's next up. The runbook instructs the lead to update it the moment tasks change (todos created, re-scoped, blocked, completed; lanes started or finished), keep it small, and at day end `pad_archive` it and write a fresh one under the same name. Archiving frees the name and keeps history readable via `pad_list(include_archived=true)`.

## Project commands (hive.yml)

Define a project's dev processes and lead in a `hive.yml` at the project root; `hive` starts them with the session:

```yaml
lead: claude --model opus     # optional command for the lead window
placement: split              # optional worker placement: split (panes, default) or window (tabs)
layout: main-vertical         # optional pane arrangement for split: tiled (default),
                              # main-vertical, main-horizontal, even-horizontal, even-vertical
dashboard: true               # optional; default false. Writes a generated, auto-refreshing
                              # HTML dashboard to .claude/dashboard/index.html on every tick:
                              # the board pad, open todos, running agents, pending wakes, and
                              # recent activity. Read-only, self-contained, opens from file://.
                              # `hive`/`hive lead` opens it in a browser once per ~8h of use
                              # (`hive lead --no-dashboard` skips this run's open).
processes:
  npm:dev: npm run dev        # shorthand; auto-starts with the session
  typecheck:                  # expanded form
    command: npx tsc --watch --preserveWatchOutput
    dir: ./packages/api       # relative to the project root
    auto_start: false         # start manually with: hive start typecheck
    env:
      NODE_ENV: development
```

Commands appear as windows in the session (visible in iTerm like everything else) and show up in `agent_list`, so the lead can read their output with `agent_output`. Because the file is repo-controlled, each command runs only after you approve it once interactively; changing a command in any way requires re-approval, and `dir` cannot escape the project root. Unknown keys are ignored, so configs from similar tools parse after a copy.

## Automatic backups

The store backs itself up automatically: a snapshot before any pending schema migration runs, and one an hour while any hive session is open, rate-limited so five concurrent sessions still produce one backup, not five. Snapshots are consistent `VACUUM INTO` copies, not file copies, which matters because hive runs in WAL mode: a plain copy of `hive.db` can silently miss everything sitting in the WAL since the last checkpoint. Each snapshot is built in a private staging directory and only renamed into place once complete, so a crash mid-backup never leaves a truncated snapshot that looks valid.

`hive backups` lists them with size and age. `hive restore <name>` overwrites the live store from one, prints exactly what it is about to replace, takes one more snapshot of the current store first, and refuses without an explicit `[y/N]` confirmation or `--yes`. It also refuses while any agent is recorded as running or a hive tmux session is still up, since replacing the database out from under an open connection is undefined behavior in SQLite; pass `--force` if you are certain nothing is using the store. Retention keeps the last 10 snapshots plus one per day for a week by default (`HIVE_BACKUP_KEEP_LAST`, `HIVE_BACKUP_KEEP_DAILY_DAYS`, both floored so a backup can never prune itself away), and `hive doctor` reports the count, total size, and whether the last attempt failed or the last success is more than `HIVE_BACKUP_STALE_DAYS` (default 7) old.

## Pads and todos from the shell

Pads are reachable from the shell too, without spending a Claude turn: `hive pads` lists them, `hive pad <name>` prints one, and `hive pad <name> --edit` exports it to a temp markdown file and opens your system's default markdown editor (override with `HIVE_EDITOR=zed` or similar). Edit, save, then `hive pad <name> --save` writes it back. The export encodes the pad revision, so if a session changed the pad while you edited, the save fails with merge instructions instead of clobbering; your edits stay in the temp file. Temp exports live in the system temp dir and clean themselves up on save (macOS purges strays automatically).

Todos are reachable from the shell too: `hive todos` lists the current project's todos, open work by default (`--all` for everything, `--status <s>` for one status, `--tag <t>` for one lane), marking blocked items so you don't pick up something that can't start yet. `hive todo <id>` prints one todo in full, comments included and never truncated, since a worker's handoff is often the only record of what it did. Both commands are read-only and silent outside a hive project; creating, completing, and commenting stay MCP-only for now.
