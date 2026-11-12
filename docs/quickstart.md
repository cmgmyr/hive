# Quick start

Zero to a running lead with one worker in about 10 minutes. This page covers the first run only; each section links to the page that owns the details.

## What you get

- A lead: a Claude Code session in a tmux window that plans the work and hands it out.
- Workers: more Claude Code (or Codex) sessions, each in its own tmux pane that you can read and type into.
- One local SQLite store shared by every session (pads, todos, wake-ups). There is no daemon.

## Requirements

- [ ] macOS.
- [ ] Node `^22.14.0 || >=23.6.0`. The range comes from the SQLite addon; see [Node version and the interpreter pin](install.md#node-version-and-the-interpreter-pin).
- [ ] [Claude Code](https://claude.com/claude-code), installed and logged in (`claude` runs).
- [ ] tmux: `brew install tmux`. **Required.** hive runs the lead and every worker in a tmux pane, so without tmux you only get the store tools (pads, todos, kv). `hive` itself stops with `tmux is not installed`.
- [ ] Optional: the `codex` CLI, only if a project opts a worker into it. See [Codex workers](install.md#codex-workers).

## Install

```bash
npm install -g @cmgmyr/hive
hive setup
brew install tmux
claude mcp add --scope user hive -- "$(command -v node)" "$(npm root -g)/@cmgmyr/hive/dist/index.js"
ln -s "$(npm root -g)/@cmgmyr/hive/claude-plugin" ~/.claude/skills/hive   # optional: session-start kickoff
hive doctor
```

Put `~/.local/bin` on your PATH below your version manager's block, or the version manager's `node` shim wins. See [install.md](install.md#node-version-and-the-interpreter-pin).

`hive doctor` prints one line per check. You want `ok` beside `version`, `node`, `better-sqlite3`, `tmux`, `claude`, `database`, `stale hive servers` and `hooks file`. Anything marked `FAIL` is a problem to fix before you go on; a `warn` is worth reading but does not block you. The last line counts both.

## Your first project

```bash
cd ~/Code/your-project
hive init
hive
```

`hive init` registers the project and writes a starter `hive.yml` (all options commented out). It asks which profile to use; pick `orchestration` if you want a lead that delegates to workers. It also seeds a `board` pad, plus a `runbook` pad when you choose no profile. Commit `hive.yml`. Add `.hive/` to your `.gitignore`.

`hive` (short for `hive lead`) opens a tmux session named `hive-main` and a `lead` window running Claude in your project. Your terminal attaches to it; under iTerm the default is its native tmux integration. For attach modes and the one-time iTerm settings, see [tmux settings](tmux.md) and [One-time iTerm settings](install.md#one-time-iterm-settings).

Type this to the lead:

```text
good morning, let's triage
```

The lead reads your profile's standing process and proposes work. With no profile, the runbook pad has it interview you first.

## Your first worker

Ask the lead for a small, self-contained job:

```text
Spawn one worker to add a one-paragraph "Contributing" section to the README, then report back.
```

The lead calls `agent_spawn`. A new pane appears beside the lead, and with the default `lead_sidebar` a crew list shows the worker and its state. Read the pane, or type into it to steer the worker directly.

When the worker finishes, hive wakes the lead with a note, so the lead does not poll. The lead reads the result and tells you what it found.

To watch or take over from another terminal, run `tmux attach -t hive-main` (or `hive attach`). In tmux, `Ctrl-b z` zooms the current pane to full screen; press it again to restore the layout.

## The config you will actually touch

Settings live in `hive.yml`. A machine-wide `~/.hive/hive.yml` holds defaults, and a project's `hive.yml` wins over it. Scalar and list keys are replaced by the project value; `vars` merge key by key. `hive doctor` prints each effective value and which file it came from. See [global defaults](configuration.md#global-defaults).

| Key | Default | What it does |
|---|---|---|
| `profile` | none | Standing instructions for the lead and workers. `none` means a seeded runbook pad instead. |
| `agents` | `claude` only | Harnesses `agent_spawn` may use; the first is the default. Add `codex` to allow it. |
| `placement` | `split` | `split` puts workers in panes of the lead's window; `window` gives each its own tab. |
| `layout` | `tiled` | Pane arrangement for `split`. `main-vertical` gives the lead half the window. |
| `attach` | `auto` | Global only. Set with `hive setup --attach <mode>`: `auto`, `control` or `raw`. See [tmux settings](tmux.md). |
| `dashboard` | `false` | Write a read-only HTML dashboard to `.hive/dashboard.html`. See [Dashboard](dashboard.md). |
| `lead_sidebar` | `true` | Crew pane in a Claude lead. See [Crew sidebar](crew.md). |
| `quiet_messaging` | `true` | Wakes and worker messages reach a Claude lead as one row instead of typed text. |
| `lead_turn_budget` | off | `{warn: 300, stop: 600}` makes the lead hand off to a fresh session at a turn count. `auto_handoff: false` turns the restart off. |
| `context_checkpoint_percent` | off | An integer 1-100: workers checkpoint when their context passes it. |
| `first_message` | none | Text sent as the lead's first turn. hive ships none. |
| `vars` | empty | Values substituted into profile text, such as test commands. |

Defaults come from `BUILT_IN_PROJECT_YML` in `src/projectYml.ts` and [configuration.md](configuration.md). The full list, including `lead`, `lead_branches`, `processes` and `completion_gate`, is in [Projects](projects.md#project-commands-hiveyml). Changes to `lead_sidebar` and `quiet_messaging` apply after you restart the lead.

## Profiles

A profile is the standing process your lead and workers follow. hive ships three: `orchestration` (a lead that delegates to workers), `simple` (one session working solo, with hive as memory) and `queen` (for the multi-project lead started by `hive queen`). Choose one in `hive init`, or set `profile:` in `hive.yml`. `hive profile list` shows what exists, `hive profile fork orchestration` copies it into `~/.hive/profiles` to edit, and the `hive:profile` skill interviews you and writes a new one. See [Profiles](profiles.md).

## Everyday commands

| Command | What it does |
|---|---|
| `hive` | Open (or return to) this project's lead. |
| `hive status` | Live view of the project's agents and state. |
| `hive doctor` | Check the environment and sweep stale state. |
| `hive todos`, `hive pads` | List the project's todos and pads from the shell. |
| `hive queen` | One lead across every registered project. See [The queen](queen.md). |
| `hive upgrade` | Update a global install. `--check` previews. |

The rest are in [Commands](commands.md).

## When something is off

- **`this Node is too old for better-sqlite3's native addon`**: the `node` hive found is outside the supported range. Run `hive setup` from a good Node, then re-register MCP with that `$(command -v node)`. See [install.md](install.md#node-version-and-the-interpreter-pin).
- **`tmux is not installed`**: run `brew install tmux`, then `hive doctor`.
- **Claude has no hive tools**: the MCP line was never added, or points at an old build. Re-run the `claude mcp add` line above; `hive doctor` prints the exact line under `mcp registration`. Restart the session after.
- **`hive` is not found, or runs the wrong Node**: `~/.local/bin` is missing from PATH or sits above your version manager's block. Under iTerm, check the PATH of the shell it launches.

Anything else: [Troubleshooting](troubleshooting.md).
