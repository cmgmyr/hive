# hive

Shared memory and coordination for Claude Code sessions.

Hive gives multiple Claude Code sessions, and the humans running them, one shared, project-scoped state store. A lead session plans work, worker sessions pick it up, and everything they need to share survives across windows and restarts. Workers are real terminal sessions in tmux panes, Claude Code by default or codex where a project opts in, so you can watch any of them think, interrupt them, or take over. Coordination is event-driven, not polled: workers report their exact state through their own CLI's hooks, so a lead can say "wake me when a worker goes idle" and go quiet until then.

## Why not just subagents?

Claude Code's built-in subagents are great for fan-out within one conversation, and hive workers can still use them. Hive covers what subagents can't:

- Subagents are invisible while they run and report only at the end. Hive workers are live terminals you read mid-task and type into.
- Subagent results vanish with the conversation. Pads and todos outlive every session, so tomorrow's lead picks up where today's stopped.
- Subagents die with their parent. Hive workers keep running when the lead detaches, restarts, or crashes.
- Subagents serve one session. The hive store is shared: several sessions, several terminals, even several humans coordinate through the same pads and todos.

## How it works

Each Claude Code session runs its own `hive` MCP server over stdio, and every instance reads and writes one SQLite database (WAL mode) at `~/.hive/hive.db`, so every session sees the same state. There is no daemon and nothing leaves your machine. State is scoped to a project (a directory), resolved from the working directory; a lead spawns workers into tmux panes locked to that project.

## Install and quick start

Requirements: macOS, Node `^22.14.0 || >=23.6.0`, [Claude Code](https://claude.com/claude-code), and tmux for the agent tools. codex is optional, only needed if a project opts a worker into it; see [docs/install.md](docs/install.md#codex-workers).

```bash
git clone <repo-url> hive && cd hive
npm install
npm run build
npm link             # puts the hive command on your PATH
hive setup           # pins that command to one interpreter
brew install tmux
claude mcp add --scope user hive -- "$(command -v node)" "$(pwd)/dist/index.js"
ln -s "$(pwd)/claude-plugin" ~/.claude/skills/hive   # optional: session-start kickoff
hive doctor          # verify: node, ABI, tmux, claude, database, hooks all green
```

`hive setup` writes a dispatcher to `~/.local/bin/hive`, and refuses to point it at a build inside a linked git worktree, since worktrees are disposable and the shim breaks the moment its target is torn down (`--force` overrides). Put that ahead of any version manager's shims in your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"     # below the version manager's block in the file
```

Both lines prepend to PATH, so whichever runs LAST ends up first. Put hive's line below the version manager's, not above it, or the version manager's shim wins and you are back to the failure `hive setup` exists to prevent.

Then start your first session:

```bash
cd ~/Code/your-project
hive
```

`hive` is shorthand for `hive lead`. It opens a `lead` window running Claude in this project's tmux session; ask it to triage, and it reads the standing process and proposes work. Spawn workers with `agent_spawn`, and watch or take over any of them with `tmux -CC attach -t hive-main` (or plain `tmux attach`).

Two more things worth turning on:

- The plugin symlink above loads hive's live state (the board, open todos, running workers) into a new session automatically on a lead branch. See [docs/profiles.md](docs/profiles.md).
- `hive statusline` prints a one-line summary of agents, todos, pads, and any held wake-ups, so you can see what's happening without switching windows. A held wake shows the count of every held wake, plus the age and reason for the one it's telling you about - a typing hold when there is one, since that's the one you can clear yourself, otherwise the oldest: `typing` (your own input box has unsubmitted text), `talking` (a message was SENT to this lead in the last five minutes - usually by you - so hive is holding the wake rather than interrupting; unlike `typing`, which is text still sitting unsent), `needs you` (nothing clears it without a `hive lead` or `wake_cancel`), or `blocked` (waiting on something else to resolve, such as a dialog). It needs a one-line addition to your Claude Code status line config to show up; see [docs/install.md](docs/install.md#status-line) for the exact snippet.

## Commands

| Command | What it does |
|---|---|
| `hive --version` | Print the version, short sha, and dirty marker this build was stamped with |
| `hive` / `hive lead` | Start, or reattach to, this project's lead session |
| `hive init` | Set up a project: writes `hive.yml`, picks a profile, seeds the board pad |
| `hive attach` | Attach to the project's tmux session without opening a lead |
| `hive start <name>` | Start a `hive.yml` process by hand |
| `hive stop <name>` / `hive stop --all` | Stop one running process, or every one in this project |
| `hive show <name>` | Move a running process's pane beside the lead |
| `hive hide <name>` | Move it back into the project's `processes` window |
| `hive status` | Every project's agents, commands, todos, and timers, in one shot |
| `hive setup` | Pin the `hive` command to the interpreter that built it |
| `hive doctor` | Check the environment and sweep stale state |
| `hive pads` / `hive pad <name>` | List pads, or print (and edit) one from the shell |
| `hive todos` / `hive todo <id>` | List todos, or print one in full |
| `hive backups` / `hive restore <name>` | List store snapshots, or restore one |
| `hive runbook` | Print this project's standing process |
| `hive posture` | Print the posture your lead is running with |
| `hive profile list` | Show the profiles hive can see |
| `hive kickoff --explain` | Check whether a session here gets the session-start injection |
| `hive statusline` | One-line store summary for Claude Code's status line |

## Configuration

Environment variables, mostly for advanced or automated setups. Everyday use needs none of these.

| Variable | Purpose |
|---|---|
| `HIVE_DATA_DIR` | Where the database lives. Default `~/.hive` |
| `HIVE_PROJECT_LOCK` | Set to `1` to reject all cross-project access in this session (set automatically for workers) |
| `HIVE_BIN_DIR` | Where `hive setup` writes and checks the dispatcher shim. Default `~/.local/bin` |
| `HIVE_SPAWN_PLACEMENT` | `split` (panes) or `window` (tabs) for new workers. Default `split` |
| `HIVE_SPAWN_READY_MS` | How long `agent_spawn` waits for a worker's prompt box. Default `45000` |
| `HIVE_EDITOR` | External editor for `hive pad <name> --edit` |
| `HIVE_PROJECT_PATH` | Set automatically by `agent_spawn`; guards a worker's project pin |
| `HIVE_LEAD` | Set automatically by `hive lead`, so its session-start hook still fires |
| `HIVE_ALLOW_DEFAULT_STORE` | Set to `1` to let a non-hive process open the real store |
| `HIVE_AUTO_ATTACH`, `HIVE_ATTACH_MODE` | Testing overrides; use `hive setup --auto-attach` / `--attach` instead |
| `HIVE_TMUX_TIMEOUT_MS` | Raise (never lower) the bound on a tmux call before hive treats it as unknown. `hive doctor` reports it when set, since a knob that shortens a safety bound must not sit in an environment silently |
| `HIVE_TEARDOWN_SIGHTING_MAX_AGE_MS` | Testing override for how recent a tmux sighting must be before a crew-teardown record may call its window `observed`. A 15-second bound cannot expire inside a test. CLAMPED to the default, so it can only ever shorten the bound: unlike `HIVE_TMUX_TIMEOUT_MS` no value of it can weaken a claim, because lengthening it would buy an `observed` the process did not earn |
| `HIVE_PTY_HEADROOM_JSON`, `HIVE_PTY_PS_ROWS_JSON`, `HIVE_ORPHAN_SCRATCH_JSON` | Testing overrides for `hive doctor`'s pty escalation: inject a full headroom reading, `ps` rows, or an orphaned-scratch-server struct instead of shelling out, to test the safety-margin crossing deterministically |
| `HIVE_BACKUP_KEEP_LAST`, `HIVE_BACKUP_KEEP_DAILY_DAYS`, `HIVE_BACKUP_STALE_DAYS` | Snapshot retention and staleness tuning |

## Updating

Both entry points, the `hive` command and the MCP registration, are live pointers into your checkout, so code updates need no reinstall or re-registration, just a rebuild and a re-pin:

```bash
cd <this checkout>
git pull --ff-only
npm install
npm run build
node dist/cli.js setup        # not `hive setup`: that runs through the OLD dispatcher
hive doctor --strict          # confirms the addon, the pin, and the registration all agree
```

## Docs

| Page | What's there |
|---|---|
| [Architecture](docs/architecture.md) | Seven diagrams: process topology, module layering, spawn sequence, wake lifecycle, worker state, project scoping, store and server identity |
| [Patterns](docs/patterns.md) | Standing trades, refused approaches, evidence standards, and guard shapes distilled from the project's own decisions and dead-ends |
| [Concepts](docs/concepts.md) | Vocabulary, identity, the workflow, project scope, the shared store |
| [Daily driver](docs/daily-driver.md) | A day with hive, starting a session, watching workers, wake-ups |
| [Profiles](docs/profiles.md) | Standing instructions across projects, the session-start plugin |
| [Projects](docs/projects.md) | `hive init`, `hive.yml`, automatic backups, pads and todos from the shell |
| [Install details](docs/install.md) | iTerm settings, the status line, MCP scope, codex workers, updating, uninstalling |
| [Troubleshooting](docs/troubleshooting.md) | Common errors and their fixes |
| [Tools](docs/tools.md) | The 44 MCP tools: what each does and when to use it |
| [tmux settings](docs/tmux.md) | Attach modes, pane options, and what to put in `~/.tmux.conf` |
| [Development](docs/development.md) | Building and testing hive itself |
