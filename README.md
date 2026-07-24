# hive

Shared memory and coordination for Claude Code sessions.

Many workers, one shared memory. Hive gives multiple Claude Code sessions (and the humans running them) one shared, project-scoped state store. A lead session plans work, worker sessions pick it up, and everything they need to share survives across windows and restarts.

Two ideas make it work. Workers are real terminal sessions in tmux panes: you can watch every one of them think, interrupt any of them, and take over at any moment. And coordination is event-driven, not polled: workers report their exact state (working, idle, waiting) through Claude Code hooks, so the lead says "wake me when a worker goes idle" and goes quiet until then.

<!-- TODO: screenshot of a lead plus tiled workers goes here -->

## Why not just subagents?

Claude Code's built-in subagents are great for fan-out within one conversation, and hive workers can still use them. Hive covers what subagents can't:

- Subagents are invisible while they run and report only at the end. Hive workers are live terminals; you read them mid-task and type into them.
- Subagent results vanish with the conversation. Pads, todos, and comments outlive every session, so tomorrow's lead picks up where today's stopped.
- Subagents die with their parent. Hive workers keep running when the lead detaches, restarts, or crashes.
- Subagents serve one session. The hive store is shared: several sessions, several terminals, even several humans coordinate through the same pads and todos.

## How it works

Each Claude Code session launches its own `hive` MCP server over stdio. All instances read and write one SQLite database (WAL mode) at `~/.hive/hive.db`, so every session sees the same state. There is no daemon and nothing leaves your machine.

State is scoped to a project (a directory). The scope resolves in this order: an explicit `project_id` argument, the session's `project_select` choice, then auto-detection from the working directory. A working directory that matches no registered project becomes a new project automatically; sessions never silently attach to an unrelated one. Use `project_select` or `project_id` to reach another project's state on purpose.

Git worktrees and subdirectories resolve to the primary checkout's project, so a worker in a worktree shares the main repo's pads and todos. To treat a worktree as its own project instead, register its path explicitly with `project_add`.

### A day with hive

```text
you   ▸ good morning, let's triage
lead  ▸ reads the runbook and board pads, lists open todos, proposes lanes
you   ▸ approve the plan
lead  ▸ agent_spawn("api"), agent_send(task + todo 12)
        agent_spawn("ui"),  agent_send(task + todo 14)
        wake_when_idle(["api", "ui"]) … goes quiet
        (both workers visible in tmux panes; watch or take over any of them)
lead  ▸ [hive wake #3] "api" went idle: reads the diff and the handoff comment,
        completes todo 12, dispatches the todo it just unblocked
you   ▸ let's wrap up
lead  ▸ collects handoffs, closes workers, archives the board, writes tomorrow's
```

### Vocabulary

| Term | Meaning |
|---|---|
| lead | The session you talk to. Plans, spawns workers, dispatches todos. `hive` starts one. |
| worker | A Claude session the lead spawns into a tmux pane, locked to the project. |
| actor | Who a write is attributed to: `user:<name>` for humans, `agent:<id>` for workers. |
| pad | A named shared document in the store. |
| runbook | The pad holding your standing instructions for a project's lead. |
| board | The pad holding today's live state; archived and rewritten each day. |
| lane | One independent stream of work: typically one worker plus one or more todos. |

### Identity

Every write records who made it. Set identity through environment variables when starting a worker session:

```bash
HIVE_AGENT_ID=worker-1 HIVE_AGENT_NAME="API worker" claude
```

Without `HIVE_AGENT_ID`, you are `user:<username>`. Ask `whoami` inside a session to check.

### The workflow

Ask any session for `help(topic="workflow")`. Short version: the lead interviews you, writes the plan to a pad, splits it into todos with blockers, and workers pull unblocked todos, comment their handoffs, and complete them. Completing a todo reports which todos it unblocked.

### The shared store

Four primitives hold all coordination state. Each is project-scoped, lives in SQLite, and is visible to every session the moment it changes. Sessions die; the store lives.

**Pads** are named shared documents: the plan, research findings, the runbook, the daily board. A pad is the right home for anything a future session should be able to read without you re-explaining it. Every read returns a `revision`, and overwrites require `expected_revision`, so two sessions can never silently clobber each other; the loser gets a conflict and re-reads. Prefer `pad_append` and `pad_edit` for small changes so revisions stay cheap. Names are unique per project, and archiving retires a pad while keeping it readable by id, which gives you clean day-to-day rotation of pads like the board.

**Todos** are the work queue. Each one carries a body (objective, owned files, acceptance criteria), a priority, tags, and a comment thread. Blockers link todos into a dependency graph: blocked work stays out of the dispatch filter until its blockers complete, cycles are rejected outright, and completing a todo reports exactly which todos it freed. Comments double as the handoff trail between workers and sessions: changed files, tests run, decisions made, remaining risk.

**KV** is a small shared JSON scratch space for values other sessions should discover on their own: a dev server port, a feature flag, a shared setting. Values can carry a TTL and expire without cleanup.

**Leases** are soft claims on shared work areas, keyed by convention (`file:src/api/routes.ts`). A lease does not lock anything; it tells other sessions "someone is working here, pick a different lane." Leases expire on their own TTL, so a crashed worker never wedges the team, and re-acquiring your own lease extends it, which doubles as a heartbeat for long work.

### Daily driver

Link the CLI once (`npm link` in this repo), then start any project's session with one command:

```bash
cd ~/Code/your-project
hive
```

`hive` is shorthand for `hive lead`. In iTerm it attaches in control mode: a `lead` window running claude opens as a native window, and every worker the lead spawns appears automatically. Detaching (or closing the windows) leaves everything running; `hive` again reattaches. `hive attach` does the same without creating a lead window.

Layout: by default workers spawn as panes in the lead's window, auto-tiled, which iTerm renders as native split panes. Full-screen the project window and the whole crew (lead plus workers) shares one screen; iTerm's normal pane navigation and resizing work. Each project is its own window, so drag project windows together as tabs if you like tabs. Prefer a tab per worker instead? Set `placement: window` in the project's `hive.yml`, pass `placement: "window"` on a single spawn, or set `HIVE_SPAWN_PLACEMENT=window` machine-wide. Spawn argument beats project config beats env.

If nothing is attached when a worker spawns, hive pops open iTerm (or Terminal) attached to the session, so workers are always visible. macOS will ask once to allow controlling iTerm; approve it. Set `HIVE_AUTO_ATTACH=0` to turn the auto-open behavior off.

### Runbook (`hive init`)

`hive init` sets a project up for orchestration. It writes a starter `hive.yml` (one active key, the rest commented examples) and seeds a `runbook` pad: the lead's standing instructions, kept in the shared store rather than the repo. The starter runbook opens with a first-run section that has the lead interview you (how work arrives, branch and PR rules, worktree setup, how workers verify, what needs explicit approval) and rewrite the pad to fit the project.

After that, opening the lead with "good morning, let's triage" is enough; every hive session is instructed to read the runbook before orchestrating. The server also exposes three playbook prompts, which Claude Code surfaces as slash commands: `/mcp__hive__triage` runs the morning ritual, `/mcp__hive__orchestrate` loads the lead/worker pattern, and `/mcp__hive__wrapup` closes the day (handoffs, worker close-out, board rotation). Pair it with a `board` pad for live state: keep the board small, and at day end `pad_archive` it and write a fresh one under the same name. Archiving frees the name and keeps history readable via `pad_list(include_archived=true)`.

### Project commands (hive.yml)

Define a project's dev processes and lead in a `hive.yml` at the project root; `hive` starts them with the session:

```yaml
lead: claude --model opus     # optional command for the lead window
placement: split              # optional worker layout: split (panes, default) or window (tabs)
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

Other CLI commands: `hive status` prints every project's running agents, commands, open todos, and timers in one shot; `hive doctor` checks the environment (node, tmux, claude, database, hooks) and sweeps stale state. The sweep also runs continuously: agents whose windows died get closed automatically, and timers pointing at dead panes get cancelled.

Pads are reachable from the shell too, without spending a Claude turn: `hive pads` lists them, `hive pad <name>` prints one, and `hive pad <name> --edit` exports it to a temp markdown file and opens your system's default markdown editor (override with `HIVE_EDITOR=zed` or similar). Edit, save, then `hive pad <name> --save` writes it back. The export encodes the pad revision, so if a session changed the pad while you edited, the save fails with merge instructions instead of clobbering; your edits stay in the temp file. Temp exports live in the system temp dir and clean themselves up on save (macOS purges strays automatically).

### Workers

A lead session spawns workers with `agent_spawn`; each worker is an agent CLI (default `claude`) in a tmux window under the session `hive-<project_id>`, started with its own actor identity and `HIVE_PROJECT_LOCK=1`. The lead types into workers with `agent_send` and reads their terminals with `agent_output`. For parallel file edits, spawn each worker in its own git worktree (`cwd` parameter); worktrees resolve to the same project, so everyone shares one plan.

Watch or take over any worker live:

```bash
tmux attach -t hive-<project_id>      # plain terminal
tmux -CC attach -t hive-<project_id>  # iTerm native windows/tabs
```

### Wake-ups, not polling

Spawned `claude` workers carry Claude Code hooks (wired via `--settings`, nothing written into your repo) that report exact state into the store the moment it changes: `working`, `idle`, or `waiting` for permission. The lead sets `wake_when_idle` on its workers and goes quiet; when a worker goes idle, the wake-up body is typed into the lead's terminal as a fresh user turn, prefixed `[hive wake #N]`. `wake_set` gives plain delayed or repeating wake-ups. The scheduler runs inside every hive server instance with atomic claims, so there is no daemon; wake-ups fire as long as any session is open.

To receive wake-ups, a lead must itself run inside tmux (workers always can). Leads started with `hive` get this automatically.

## Setup

Requirements: macOS, Node 18+, [Claude Code](https://claude.com/claude-code), and tmux for the agent tools. Everything except spawning workers runs without tmux.

```bash
git clone <repo-url> hive && cd hive
npm install          # if npm blocks the better-sqlite3 build script, run: npm approve-scripts better-sqlite3
npm run build
npm link             # puts the hive command on your PATH
brew install tmux
claude mcp add --scope user hive -- node "$(pwd)/dist/index.js"
hive doctor         # verify: node, tmux, claude, database, hooks all green
```

Then start your first session:

```bash
cd ~/Code/your-project
hive
```

The first time a worker spawns with nobody attached, macOS asks permission for hive to control iTerm; approve it once.

One-time iTerm settings (Settings > General > tmux), per machine:

- Check "Automatically bury the tmux client session after connecting". Without this, every attach leaves an idle gateway window in the background. Don't close that window by hand; closing it detaches the whole session. Bury applies on the next attach.
- Set "When attaching, restore windows as" to "Native tabs in the attaching window". Running `hive` then opens the session as tabs in the window you ran it from instead of spawning a new macOS window. ("Native tabs in a new window" also works if you prefer the session in its own window.)
- Optional: check "Unpause automatically" under Pausing. Claude sessions stream heavy output, and this keeps a lagging pane from freezing its display. Delivery is unaffected either way; wake-ups and `agent_send` go through the tmux server, not the display.

Notes on MCP scope: `--scope user` makes hive available in every project, which is right for most machines. If you also run another MCP server with similar tool names (`todo_create`, `kv_set`, `lease_acquire`), register per project instead: this repo ships a `.mcp.json` you can copy (use an absolute path in `args`), or run `claude mcp add hive -- node /absolute/path/to/hive/dist/index.js` from that project's directory. Loading two overlapping catalogs in one session invites Claude to write to the wrong store.

## Updating

Both entry points are live pointers into this checkout: `npm link` points the `hive` command at `dist/cli.js`, and the MCP registration runs `node <checkout>/dist/index.js`. Updates need no reinstall and no re-registration, on any machine:

```bash
cd <this checkout>
git pull
npm install             # only matters when dependencies changed; harmless otherwise
npm run build
```

The new code reaches each entry point at a different time:

- The `hive` CLI picks it up immediately; every invocation is a fresh process.
- New Claude Code sessions pick it up immediately; each session starts its own server from `dist/`.
- Sessions already running keep the old server in memory. Run `/mcp` in that session and reconnect hive, or let it catch up when the session ends. Pulling before you open sessions for the day avoids this entirely.

When developing hive itself, this project's `hive.yml` auto-starts `npm run watch`, which replaces the manual build step. The restart rules for running sessions still apply.

## Uninstall

Hive touches four things on a machine; remove them in any order:

```bash
tmux kill-server                # stop any running hive sessions first
claude mcp remove hive          # the MCP registration (add --scope user if registered there)
npm rm -g hive                  # the linked hive command
rm -rf ~/.hive                  # database, hooks file, and ALL shared state
```

Then revoke the automation permission under System Settings > Privacy & Security > Automation (the entry allowing your terminal to control iTerm), and delete the checkout.

## Troubleshooting

- `hive doctor` is the first stop. It checks node, tmux, claude, the database, and the hooks file, sweeps dead agents and undeliverable wake-ups, and prints one ok/fail line per check with the reason.
- "This session cannot receive wake-ups: it is not running inside tmux": the lead was started with bare `claude` instead of `hive`. Start it with `hive` (or inside tmux) and wake-ups deliver.
- An idle background iTerm window after attaching: enable the gateway bury setting from Setup. Don't close that window by hand; it detaches the session.
- `npm install` fails on better-sqlite3: run `npm approve-scripts better-sqlite3` (newer npm blocks build scripts by default), then `npm install` again.
- Claude writes todos or kv to the wrong store: two MCP servers with overlapping tool names are loaded in one session. See the MCP scope note in Setup.

## Tools (36)

Every tool is project-scoped: it acts on the current working directory's project without an explicit override.

| Tool | What it does | When to use it |
|---|---|---|
| **identity** | | |
| `whoami` | Shows your actor id and effective project scope | First call in a new session, or whenever scope looks wrong |
| `help` | Usage guidance; accepts a topic (`workflow`, `agents`, `wakes`, `pads`, ...) | To learn the lead/worker playbook without reading source |
| **projects** | | |
| `project_list` | Lists registered projects and which one is selected | To check what this machine knows about |
| `project_add` | Registers a directory as its own project | To split a worktree or subdirectory off from its parent repo's state |
| `project_select` | Points this session at another project | Cross-project work you asked for by name; workers with `HIVE_PROJECT_LOCK=1` can't |
| **agents** | | |
| `agent_spawn` | Starts a worker (default `claude`) in a tmux pane or window, locked to the project | One worker per parallel work stream; prepend the returned instructions to your first `agent_send` |
| `agent_list` | Lists this project's agents with live status | Morning triage, or before spawning more |
| `agent_status` | One agent in detail, with a short terminal tail | To check on a specific worker |
| `agent_send` | Types text or key presses into a worker's terminal | To give a worker its task, answer a prompt, or press Enter/Escape for it |
| `agent_output` | Reads the worker's rendered terminal, up to 200 lines | To read real results before calling a lane done |
| `agent_close` | Kills the worker's window and marks it closed | After capturing handoffs; terminal output is not retained |
| **wake-ups** | | |
| `wake_set` | Types its body into a terminal after a delay, as a fresh user turn | Delayed or repeating check-ins; write the body self-contained (ids, context, next action) |
| `wake_when_idle` | Fires when watched workers go idle, using exact hook state | The lead's main loop: dispatch, set this, go quiet; never poll |
| `wake_list` | Lists pending wake-ups | To see what is scheduled |
| `wake_cancel` | Cancels a pending wake-up you own | When the plan changes |
| **pads** | | |
| `pad_write` | Creates a named pad, or overwrites one with `expected_revision` | Shared plans, findings, the runbook, the board |
| `pad_read` | Full content plus revision and metadata | Before editing, and whenever a pad is referenced |
| `pad_append` | Adds to the end of a pad | Logs and running notes |
| `pad_edit` | Replaces one literal text occurrence | Targeted changes without rewriting the pad |
| `pad_list` | Pad summaries; filters by query or tags | Discovery without paying for full content |
| `pad_archive` | Retires a pad but keeps it readable by id | Day-end board rotation; frees the name for a fresh pad |
| `pad_delete` | Permanently deletes a pad | Rarely; prefer `pad_archive` |
| **todos** | | |
| `todo_create` | New todo with body, priority, tags, and optional `blocked_by` ids | One todo per unit of dispatchable work |
| `todo_list` | Todo summaries with filters | `is_blocked=false, status="open"` finds work ready to dispatch |
| `todo_get` | One todo in full: body, blockers, comments | Before starting or reviewing a task |
| `todo_update` | Edits fields and status | Set `in_progress` while working |
| `todo_complete` | Completes or reopens; returns ids it newly unblocked | Finish work and immediately see what it freed up |
| `todo_comment` | Appends a comment | Handoffs: changed files, tests run, remaining risk |
| `todo_block` | Adds a dependency; cycles are rejected | Encode ordering between tasks |
| `todo_unblock` | Removes one dependency | When ordering changes |
| **kv** | | |
| `kv_set` | Stores a small shared JSON value, optional TTL | Flags, ports, shared config other sessions should find |
| `kv_get` | Reads a value by key | |
| `kv_list` | Lists values, optional key prefix | |
| `kv_delete` | Removes a key | |
| **leases** | | |
| `lease_acquire` | Claims a named work area with a TTL; re-taking your own lease extends it | Before editing shared file areas; expired leases free themselves |
| `lease_release` | Releases a lease you own | When done early; otherwise TTL handles it |

Conventions borrowed from tools that got this right:

- Write tools return slim receipts (`{project_id, todo_id}`) to keep token cost down.
- Pads use optimistic concurrency: reads return a `revision`, overwrites require `expected_revision`.
- Leases and kv TTLs expire on their own, so a dead session never wedges the team.
- Todo blockers form a dependency graph; cycles are rejected.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `HIVE_DATA_DIR` | Where the database lives | `~/.hive` |
| `HIVE_AGENT_ID` | Stable actor id for this session | `user:<username>` |
| `HIVE_AGENT_NAME` | Display name for this session | the actor id |
| `HIVE_PROJECT_LOCK` | Set to `1` to reject all cross-project access in this session (good for workers) | off |
| `HIVE_AUTO_ATTACH` | Set to `0` to stop spawns from popping open a terminal when nothing is attached | on |
| `HIVE_SPAWN_PLACEMENT` | `split` (workers tile as panes in the lead's window) or `window` (tab per worker) | `split` |

## Development

```bash
npm run build    # compile to dist/
npm run watch    # compile on change
```

Smoke test without touching your real data:

```bash
HIVE_DATA_DIR=/tmp/hive-test node dist/index.js
# then speak JSON-RPC on stdin, or just register it with Claude Code
```
