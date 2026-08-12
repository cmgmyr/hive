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
        wake_when_idle(scope="project") … goes quiet, and stays watched
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

Install the CLI once (`npm link && hive setup` in this repo), then start any project's session with one command:

```bash
cd ~/Code/your-project
hive
```

`hive` is shorthand for `hive lead`. It attaches to the project's tmux session: with the default `auto` attach mode under iTerm, a `lead` window running claude opens as a native window (tmux control mode), and every worker the lead spawns appears automatically as its own native window or pane. Detaching (or closing the windows) leaves everything running; `hive` again reattaches. `hive attach` does the same without creating a lead window. Prefer a plain tmux session over iTerm's native windows? See [Attach mode](#attach-mode) below.

Layout: by default workers spawn as panes in the lead's window, auto-tiled; under control mode iTerm renders these as native split panes, and under a raw attach they are ordinary tmux panes in one terminal window. Full-screen the project window and the whole crew (lead plus workers) shares one screen; pane navigation and resizing work either way. Each project is its own tmux window, which control mode maps to an iTerm tab; drag them together if you like tabs. Prefer a tab (or window) per worker instead of one shared window? Set `placement: window` in the project's `hive.yml`, pass `placement: "window"` on a single spawn, or set `HIVE_SPAWN_PLACEMENT=window` machine-wide. Spawn argument beats project config beats env.

Want the lead to have a prominent pane instead of an even grid? Set `layout: main-vertical` in `hive.yml` (or pass `layout: "main-vertical"` on a single spawn) and the lead fills the left half with workers stacked on the right. The options are `tiled` (default), `main-vertical`, `main-horizontal`, `even-horizontal`, and `even-vertical`; the `main-*` ones give the lead half the window. hive re-applies the layout when a worker closes as well as when one spawns, so it survives crew changes.

When no tmux client is attached anywhere on hive's tmux server and a worker spawns, hive pops open iTerm (or Terminal) attached to the session, so workers surface after you close your terminal without opening extra windows while you are watching another project. macOS will ask once to allow controlling iTerm; approve it. This default is `hive setup --auto-attach auto`; use `off` to disable auto-open, or `on` to watch only the shared base session rather than every tmux session on the server - a narrower check than `auto`'s, and one that a normal attach (which opens its own view session grouped with base, never a direct client on base itself) rarely satisfies. Use `hive setup --attach raw` to keep the pop-open but drop control mode in favor of a plain `tmux attach`. One case never pops a window whatever the setting says: a hive whose own tmux server is a private one, meaning you are inside `tmux -L something`, or you set `TMUX_TMPDIR` to a directory tmux can reach. (A `TMUX_TMPDIR` naming a directory that does not exist is not private at all; tmux does not create it and falls back to the shared server.) The window hive opens gets a fresh shell that inherits nothing from hive, so hive cannot make it land on your private server, and a window on the wrong server cannot reach the session it was told to attach to.

### Attach mode

Two places decide whether tmux attaches carry iTerm's control mode (`-CC`): your own `hive lead`/`hive attach`, and the auto-open above. One stored setting controls both:

| `hive setup --attach <mode>` | `hive lead` / `hive attach` | Auto-open |
|---|---|---|
| `auto` (default) | control mode iff your terminal is iTerm | iTerm in control mode, then Terminal |
| `raw` | never control mode | iTerm running a plain `tmux attach`, then Terminal |
| `control` | always control mode | unchanged from `auto` |

`auto` is today's behavior: nothing changes if you never touch this. Prefer tmux's own key bindings over `-CC`'s window management, or want a raw tmux session under any terminal? `hive setup --attach raw`. hive configures the tmux windows it creates, so raw mode needs no global pane-border settings. If you also run Claude Code in panes hive did not create, `allow-passthrough all` remains a global notification recommendation; setup prints that one line, and [docs/tmux.md](docs/tmux.md) explains why. `hive doctor` reports the effective mode, where it came from, and the settings carried by hive-owned windows.

### Profiles (standing instructions across projects)

A profile is a named set of standing instructions shared across projects. It is how a lead knows how you work before you tell it anything.

```
<checkout>/profiles/<name>/     hive's defaults, updated by git pull
~/.hive/profiles/<name>/        your overrides, copy-on-write
```

Resolution is per file, not per profile, so a file you never forked keeps tracking hive's default while the ones you did are yours. Three files make up a profile:

| File | How it reaches the model | What hive ships |
|---|---|---|
| `posture.md` | Appended to the lead's system prompt by `hive lead`; `hive posture` shows it | Real content: lead-not-IC, name the lane, ask on ambiguity, don't poll |
| `runbook.md` | On demand, `hive runbook` | A skeleton. Headers plus facts true of any hive project. Your process is yours to write |
| `worker.md` | Appended to each worker's system prompt by `agent_spawn` | The worker brief: identity, project lock, tool contract, lane discipline |

Two profiles ship: `orchestration` (a lead delegating to workers) and `simple` (one session doing the work itself, posture only).

```bash
hive profile list                      # what exists, where each file resolves, what drifted
hive profile fork orchestration        # copy hive's defaults into ~/.hive to edit
hive profile fork orchestration runbook.md   # or just one file
hive profile create mine --from simple
hive runbook                           # this project's process, vars resolved
hive posture                           # what your lead is actually running with
```

Pick one per project in `hive.yml`:

```yaml
profile: orchestration
lead_branches: [main, master]   # where the session-start kickoff fires
vars:
  repo: owner/name
  ticket_prefix: DEVX
  install: pnpm install
```

All three files take `{{repo}}` and friends from `vars`, and drop whole sections whose var is unset, so one profile serves a repo with a ticket tracker and one without. `posture.md` is delivered as a path, so `hive lead` renders it into a generated file under `~/.hive/postures/` (one per project, overwritten each run) and points the flag at that; `hive posture` prints the same text, which is the only way to see what your lead actually started with. An undefined var stays visible as `{{name}}` rather than silently emptying, and `hive doctor` reports which vars a runbook references and which the project defines.

`vars` are repo-controlled and land in system prompts, with no approval step. Commands in `hive.yml` do have one, because hive executes them; `vars` are only quoted into a prompt, and Claude Code's own workspace trust already governs the wider version of that channel by loading a repo's `CLAUDE.md`. The practical consequence: a `hive.yml` you did not write reaches your workers' system prompts as soon as you run hive in that checkout, so read one the way you would read that repo's `CLAUDE.md`. hive is not a defense against opening a checkout you do not trust and does not pretend to be.

Your forks are never overwritten. hive records the hash of what it shipped at fork time, so `hive profile list` and `hive doctor` can tell you when upstream moved and leave the decision to you.

### Session-start kickoff (optional plugin)

Symlink the plugin once per machine (not per project) and a session opened in a project root, on a lead branch, with a profile that resolves, starts with hive's live state already loaded: the board pad, in-flight and dispatchable todos, running workers, pending wake-ups, and an instruction to run triage.

```bash
ln -s <checkout>/claude-plugin ~/.claude/skills/hive
```

One symlink covers every project on the machine, so there is nothing to repeat when you add the next one. `hive init` checks for it and tells you which of the three states you are in: not installed, already installed, or pointing at a different hive checkout.

A folder under a skills directory holding `.claude-plugin/plugin.json` loads as a plugin on the next session, discovered in place rather than copied, so it upgrades with `git pull && npm run build` like everything else. It stays silent everywhere else: in a worker session, in a directory with no `hive.yml`, on a feature branch, below the project root, or when the profile named in a committed `hive.yml` is not on this machine. Run `hive kickoff --explain` anywhere to see which gate stopped it.

### Runbook and board (`hive init`)

`hive init` sets a project up. It writes a starter `hive.yml`, asks which profile the project should use (or takes `--profile <name>` / `--no-profile`), and seeds the `board` pad, the live picture of the work.

A project **with** a profile reads its process from `hive runbook` and gets no runbook pad; a second copy in the store would only go stale. A project on `profile: none` gets the `runbook` pad instead, seeded with a starter template whose first-run section has the lead interview you (how work arrives, branch and PR rules, worktree setup, how workers verify, what needs explicit approval) and rewrite it to fit. Either way `hive runbook` prints the right one.

After that, opening the lead with "good morning, let's triage" is enough; every hive session is instructed to read the standing process before orchestrating. The server also exposes three playbook prompts, which Claude Code surfaces as slash commands: `/mcp__hive__triage` runs the morning ritual, `/mcp__hive__orchestrate` loads the lead/worker pattern, and `/mcp__hive__wrapup` closes the day (handoffs, worker close-out, board rotation).

The board holds today's lanes, what's waiting on you, and what's next up. The runbook instructs the lead to update it the moment tasks change (todos created, re-scoped, blocked, completed; lanes started or finished), keep it small, and at day end `pad_archive` it and write a fresh one under the same name. Archiving frees the name and keeps history readable via `pad_list(include_archived=true)`.

### Project commands (hive.yml)

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

Other CLI commands: `hive status` prints every project's running agents, commands, open todos, and timers in one shot; `hive runbook` prints this project's standing process; `hive posture` prints the posture its lead runs with; `hive profile list` shows the profiles hive can see; `hive kickoff --explain` says whether a session here would get the session-start injection and why; `hive setup` re-pins the `hive` command to the interpreter this checkout was built with; `hive doctor` checks the environment (node and its ABI, the dispatcher, the MCP registration, tmux, claude, database, hooks, and the active profile) and sweeps stale state. The sweep also runs continuously: agents whose windows died get closed automatically, and timers pointing at dead panes get cancelled.

The store backs itself up automatically: a snapshot before any pending schema migration runs, and one an hour while any hive session is open, rate-limited so five concurrent sessions still produce one backup, not five. Snapshots are consistent `VACUUM INTO` copies, not file copies, which matters because hive runs in WAL mode: a plain copy of `hive.db` can silently miss everything sitting in the WAL since the last checkpoint. Each snapshot is built in a private staging directory and only renamed into place once complete, so a crash mid-backup never leaves a truncated snapshot that looks valid. `hive backups` lists them with size and age; `hive restore <name>` overwrites the live store from one, prints exactly what it is about to replace, takes one more snapshot of the current store first, and refuses without an explicit `[y/N]` confirmation or `--yes`. It also refuses while any agent is recorded as running or a hive tmux session is still up, since replacing the database out from under an open connection is undefined behavior in SQLite; pass `--force` if you are certain nothing is using the store. Retention keeps the last 10 snapshots plus one per day for a week by default (`HIVE_BACKUP_KEEP_LAST`, `HIVE_BACKUP_KEEP_DAILY_DAYS`, both floored so a backup can never prune itself away), and `hive doctor` reports the count, total size, and whether the last attempt failed or the last success is more than `HIVE_BACKUP_STALE_DAYS` (default 7) old.

Pads are reachable from the shell too, without spending a Claude turn: `hive pads` lists them, `hive pad <name>` prints one, and `hive pad <name> --edit` exports it to a temp markdown file and opens your system's default markdown editor (override with `HIVE_EDITOR=zed` or similar). Edit, save, then `hive pad <name> --save` writes it back. The export encodes the pad revision, so if a session changed the pad while you edited, the save fails with merge instructions instead of clobbering; your edits stay in the temp file. Temp exports live in the system temp dir and clean themselves up on save (macOS purges strays automatically).

Todos are reachable from the shell too: `hive todos` lists the current project's todos, open work by default (`--all` for everything, `--status <s>` for one status, `--tag <t>` for one lane), marking blocked items so you don't pick up something that can't start yet. `hive todo <id>` prints one todo in full, comments included and never truncated, since a worker's handoff is often the only record of what it did. Both commands are read-only and silent outside a hive project; creating, completing, and commenting stay MCP-only for now.

### Workers

A lead session spawns workers with `agent_spawn`; each worker is an agent CLI (default `claude`) in a tmux pane or window, started with its own actor identity and `HIVE_PROJECT_LOCK=1`. One session (`hive-main`) holds every project in the store, one window per project; a worker lands in its spawning lead's own window, next to it. The lead types into workers with `agent_send` and reads their terminals with `agent_output`. For parallel file edits, spawn each worker in its own git worktree (`cwd` parameter); worktrees resolve to the same project, so everyone shares one plan.

Watch or take over any worker live:

```bash
tmux attach -t hive-main      # plain terminal
tmux -CC attach -t hive-main  # iTerm native windows/tabs
```

`hive attach` runs one of these for you already, picked by [attach mode](#attach-mode). Every terminal attaching from outside tmux gets its own view onto the same windows rather than fighting another one over its current window; see docs/tmux.md's "Every terminal gets its own view onto the same windows".

### Wake-ups, not polling

Spawned `claude` workers carry Claude Code hooks (wired via `--settings`, nothing written into your repo) that report exact state into the store the moment it changes: `working`, `idle`, or `waiting` for permission. The lead sets `wake_when_idle` and goes quiet; when a worker goes idle, the wake-up body is typed into the lead's terminal as a fresh user turn, prefixed `[hive wake #N]`. `wake_when_idle(scope: "project")` is a **standing watch** over the whole crew: it reports each worker as it finishes or its window dies, it covers workers spawned after it was set, and it keeps watching until it expires or is cancelled, so a lead running several workers never has to re-arm it and cannot miss a finish in the gap. `wake_when_idle(agents: [...])` is the one-shot version over a named list, which stops watching the others once it fires. `wake_set` gives plain delayed or repeating wake-ups. The scheduler runs inside every hive server instance with atomic claims, so there is no daemon; wake-ups fire as long as any session is open.

To receive wake-ups, a lead must itself run inside tmux (workers always can). Leads started with `hive` get this automatically.

## Setup

Requirements: macOS, Node `^22.14.0 || >=23.6.0`, [Claude Code](https://claude.com/claude-code), and tmux for the agent tools. Everything except spawning workers runs without tmux.

That Node range is `better-sqlite3`'s, not hive's own code's, and it is two ranges rather than one floor because a Node-API level starts once per release line: the addon needs Node-API 10, which begins at 22.14.0 on the 22 line and 23.6.0 on the 23 line. Node 23.0.0 through 23.5.0 satisfy a plain "22.14 or newer" and cannot load the addon.

```bash
git clone <repo-url> hive && cd hive
npm install
npm run build
npm link             # puts the hive command on your PATH
hive setup           # pins that command to one interpreter, whatever `node` resolves to later
brew install tmux
claude mcp add --scope user hive -- "$(command -v node)" "$(pwd)/dist/index.js"
ln -s "$(pwd)/claude-plugin" ~/.claude/skills/hive   # optional: session-start kickoff
hive doctor         # verify: node, ABI, tmux, claude, database, hooks all green
```

`npm install` needs no compiler. `better-sqlite3` 13 ships its addon prebuilt, one file per platform and architecture, and the install picks the right one out of the tarball. npm does run a node-gyp step for the package, because its tarball contains a `binding.gyp`. On a platform with a prebuild that step compiles nothing, and on one without it builds from source, which is the only case where a toolchain matters. `package.json` DENIES that script (`"allowScripts": {"better-sqlite3@13.0.3": false}`), so npm skips it and prints nothing. That is safe wherever a prebuild exists, which is every platform this project runs on, and it means no dependency code executes during install. On a platform with no prebuild it is the denial that leaves you without an addon; `hive doctor` names that case and the repair.

Both `hive setup` and the `mcp add` line exist for the same reason: hive must not let the working directory pick its interpreter. The addon is not tied to one Node version; it is N-API, so it loads under any Node in the range above. But a Node version manager (asdf, nvm, volta, fnm, mise, Herd) resolves `node` per directory, and a directory can pin one *below* that range. Under such a Node the addon does not report an error. It kills the process inside `dlopen`, with no stack trace and no output at all. Pinning is what stops a `cd` from doing that.

`hive setup` writes a two-line dispatcher to `~/.local/bin/hive` that execs hive's CLI under an absolute interpreter, taken from the Node running setup. Put that directory ahead of your version manager's shims, since those usually prepend themselves. Both lines prepend, so whichever runs last ends up first, and hive's has to sit below the version manager's block in the file:

```bash
export PATH="$HOME/.local/bin:$PATH"     # in ~/.zshrc, below the version manager's block
```

Setup prints which interpreter it pinned and whether a version manager can remove it later; `hive doctor` reports the ordering and warns when something else on PATH shadows the dispatcher. Use `--dir` to write it somewhere else. Without setup you keep `npm link`'s shim, which lives in the active Node version's global directory and disappears in any directory pinning another version.

Register the interpreter, not its name. `$(command -v node)` expands once, at registration, and freezes the absolute path of the Node you just built with. A bare `node` is resolved by Claude Code at launch instead, through whatever shim the launch directory pins, so a session started in a repo on a different Node major starts hive's server under that Node and `better-sqlite3` refuses to load with `ERR_DLOPEN_FAILED`. If you later build hive with a different Node, re-register: `claude mcp remove --scope user hive`, then the line above.

Then start your first session:

```bash
cd ~/Code/your-project
hive
```

The first time a worker spawns with nobody attached, macOS asks permission for hive to control iTerm; approve it once. This applies under either attach mode: `raw` still opens iTerm, just without control mode.

With the default `auto` attach mode (or `control`), one-time iTerm settings (Settings > General > tmux), per machine:

- Check "Automatically bury the tmux client session after connecting". Without this, every attach leaves an idle gateway window in the background. Don't close that window by hand; closing it detaches the whole session. Bury applies on the next attach.
- Set "When attaching, restore windows as" to "Native tabs in the attaching window". Running `hive` then opens the session as tabs in the window you ran it from instead of spawning a new macOS window. ("Native tabs in a new window" also works if you prefer the session in its own window.)
- Optional: check "Unpause automatically" under Pausing. Claude sessions stream heavy output, and this keeps a lagging pane from freezing its display. Delivery is unaffected either way; wake-ups and `agent_send` go through the tmux server, not the display.

None of these apply under `hive setup --attach raw`: iTerm's tmux integration (and its "bury"/"restore windows as" settings) only activates for a `tmux -CC` client, and a raw attach never runs one.

Optional: show the store in Claude Code's status line. `hive statusline` prints a one-line summary (`⬡ hive: 2 agents · 4 todos (2 ready) · 3 pads`) and prints nothing when a project has no live state (no agents, todos, pads, or wake-ups) or is not registered at all, so it is safe to run everywhere. If you use a custom status line script, append:

```bash
# Hive store summary (second line, only inside hive-enabled projects).
# Use a plain if, not `[ ... ] && printf`: as the last command in the
# script, that pattern exits 1 when the line is empty and a failing
# status line command renders nothing at all.
if command -v hive >/dev/null 2>&1; then
  hive_line=$(hive statusline 2>/dev/null)
  if [ -n "$hive_line" ]; then
    printf '\n%s' "$hive_line"
  fi
fi
```

The status line only re-renders on session activity by default. Add `"refreshInterval": 10` to the `statusLine` block in `~/.claude/settings.json` so the counts stay current while the session sits idle:

```json
"statusLine": {
  "type": "command",
  "command": "~/.claude/statusline.sh",
  "refreshInterval": 10
}
```

Notes on MCP scope: `--scope user` makes hive available in every project, which is right for most machines. If you also run another MCP server with similar tool names (`todo_create`, `kv_set`, `lease_acquire`), register per project instead: run `claude mcp add hive -- "$(command -v node)" /absolute/path/to/hive/dist/index.js` from that project's directory. Loading two overlapping catalogs in one session invites Claude to write to the wrong store.

Register hive in one scope only. A project-scoped registration shadows the user-scoped one, and `claude mcp list` is the way to catch it: two entries named hive means the project one is what your session is actually running.

## Updating

Both entry points are live pointers into this checkout: the `hive` command runs `dist/cli.js`, and the MCP registration runs `<absolute node> <checkout>/dist/index.js`. Code updates need no reinstall and no re-registration:

```bash
cd <this checkout>
git pull --ff-only            # refuses instead of merging or rebasing over local changes it should not touch
npm install                   # only matters when dependencies changed; harmless otherwise
npm run build
node dist/cli.js setup        # not `hive setup`: that runs through the OLD dispatcher, which may no
                               # longer point at a Node that can load the addon
hive doctor --strict          # required: confirms the addon, the pin, and the registration all agree
                              # --strict stops the chain on those; routine warnings do not gate
```

The pin is the part that can drift, and the way it drifts changed with `better-sqlite3` 13. The addon is no longer built here, so it is no longer built *against* a particular Node, and an update cannot leave the addon and the interpreter disagreeing about a compiled ABI. What can still happen is that the interpreter running setup is not the one you want pinned, or that a version manager retires the Node your dispatcher names. Re-running setup costs nothing when nothing changed, and `hive doctor` says so either way. If the interpreter changed, the MCP server needs re-registering too, and `hive setup` prints the exact line for it: pinning the `hive` command does not touch the registration Claude Code starts the server from. Setup says nothing when the registration already runs the interpreter it pinned.

`npm install` deciding a package is up to date is not proof the addon file is still there, and this is measured rather than assumed: delete `node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node`, run a plain `npm install`, and it prints `up to date` without restoring it. The repair is to make npm reinstall the package rather than re-examine it:

```bash
rm -rf node_modules/better-sqlite3 && npm install    # ~1s, no compiler; npm ci does the same for the whole tree
```

`npm rebuild better-sqlite3` also repairs it, and is the wrong tool: with the prebuild gone it does a full source build into `build/Release/`, which works and which hive will load, but it needs node-gyp, Python and a C++ toolchain to reproduce a file the tarball already contains. This step used to be in the list above for exactly this case. It is gone because on a healthy tree it can accomplish nothing: the package's own `binding.gyp` makes npm's node-gyp step a no-op whenever a prebuild for the host is present.

Run `hive doctor` last, every time: it is the step that actually verifies the addon, the pin, and the registration agree, rather than assuming the steps above got there.

The plugin symlink is a live pointer too, so the session-start hook and the shipped profile defaults update with the same pull. Files you forked into `~/.hive/profiles/` are yours and are never touched; `hive doctor` tells you when hive's version of one moved.

The new code reaches each entry point at a different time:

- The `hive` CLI picks it up immediately; every invocation is a fresh process.
- New Claude Code sessions pick it up immediately; each session starts its own server from `dist/`.
- Sessions already running keep the old server in memory. Run `/mcp` in that session and reconnect hive, or let it catch up when the session ends. Pulling before you open sessions for the day avoids this entirely.

When developing hive itself, this project's `hive.yml` auto-starts `npm run watch`, which replaces the manual build step. The restart rules for running sessions still apply.

## Uninstall

Hive touches six things on a machine; remove them in any order:

```bash
hive status                     # confirm the session name, then end it:
tmux kill-session -t =hive-main # every project's windows live in this one session
tmux ls | grep view- || true    # a second terminal's attach opens its own VIEW
                                 # session grouped with hive-main; kill those
                                 # too (or just close their terminals - a view
                                 # destroys itself once its own client detaches)
claude mcp remove hive          # the MCP registration (add --scope user if registered there)
npm rm -g hive                  # the linked hive command
rm ~/.local/bin/hive            # the dispatcher hive setup wrote, if you ran it
rm ~/.claude/skills/hive        # the session-start plugin symlink, if you made it
rm -rf ~/.hive                  # database, hooks file, forked profiles, ALL shared state
```

One session holds every project, so this is one `kill-session`, not one per project - but only when nothing else is attached. A window belongs to every session it is grouped with, not only to `hive-main`, so `kill-session -t =hive-main` does not tear the windows down while a VIEW session (opened by any other terminal's `hive attach`, `hive lead`, or `hive <project>`) is still holding them; the windows simply keep living under that view until it too is killed or its last client detaches. `tmux kill-server` would take down every tmux session on the machine, including ones that have nothing to do with hive. Sessions also end on their own once their panes exit, so you can skip the first two lines entirely if nothing is running.

Then revoke the automation permission under System Settings > Privacy & Security > Automation (the entry allowing your terminal to control iTerm), and delete the checkout.

## Troubleshooting

- `hive doctor` is the first stop. It checks node and its ABI, the dispatcher and its place on PATH, the MCP registration, tmux, claude, the database, and the hooks file, sweeps dead agents and undeliverable wake-ups, and prints one ok/warn/fail line per check with the reason. Its last line carries both counts, `2 problem(s) found, 1 warning(s).`, so a script can read a result off it without parsing the report.
- `hive doctor` also asks, for every registered project that has a `hive.yml`, whether a session starting *there* could load the addon. It resolves one `node` per project directory, the way a version manager does, and warns by name when a project's own interpreter cannot load it. That is a warning and not a failure: a repo pinning an old Node may be perfectly fine and never run a hive worker. It is the check that would have named `a-work-repo`, pinned at nodejs 20.9.0, instead of leaving one machine's sessions looking intermittently broken. When a project fails, doctor also loads the addon under the interpreter your dispatcher pins before saying the session-start re-exec covers it, so "covered" is measured rather than assumed. The answer is for the environment you ran doctor in, since the environment a future session inherits does not exist yet. Inside a session with `HIVE_PROJECT_LOCK=1`, which is every hive-spawned worker, it reports only that session's own project.
- `hive doctor --strict` exits non-zero on the warnings that mean **this install is wrong**: the dispatcher, the MCP registration, and the addon. Put it in an update script, where a dispatcher and an MCP registration naming different Nodes is the whole reason you ran doctor. The summary line says how many warnings were promoted, so a run that warns about something else still ends `0 promoted by --strict` and exits 0.
- **Not every warning gates, and that is deliberate.** Doctor warns during ordinary healthy operation: a lead row is left running after a session exits (by design, and the next `hive lead` clears it), a registered project pins a Node too old for the addon (that project's business, and it warns on every run for as long as it exists), a `hive.yml` has a misspelled key, a forked profile has drifted from hive's default. Promoting those would make `--strict` exit non-zero on a healthy machine, which is an exit code you learn to ignore. A new check is non-gating unless its author opts in, so adding one cannot start failing your update script the day it lands.
- `hive: this Node is too old for better-sqlite3's native addon`: the Node running hive is below the range in Setup. `hive doctor` names the Node-API level the addon needs and the one this interpreter provides. Run hive under a Node in that range and re-pin to it, naming that interpreter: `"<that node>" <checkout>/dist/cli.js setup`. Setup pins whatever Node runs it and the `hive` on your PATH is the one that just failed. Rebuilding does not help: `better-sqlite3`'s own build asks for the same Node-API level a fresh install does.
- `hive: better-sqlite3's native addon is not built here`: the addon file is missing. `rm -rf node_modules/better-sqlite3 && npm install` restores it from the tarball. If it is still missing after that, this platform and architecture have no prebuild, and the only route left is a source build inside the package: `cd node_modules/better-sqlite3 && npm run build-release`.
- `ERR_DLOPEN_FAILED`, or `NODE_MODULE_VERSION 137 ... requires 147`: an addon compiled for one Node major, loaded under another. `better-sqlite3` 13's prebuilds are N-API and cannot produce this, so on a current install it means something put a pre-13 addon in the tree. `hive doctor` names both numbers.
- `The hive dispatcher pins <path>, which is not on disk`, printed as part of the addon banner: a version manager removed the Node your dispatcher names. The session-start hook is registered under a bare `node` (its file is tracked in git and cannot carry an absolute path), so in a project pinning a Node that cannot load the addon it re-execs into the pinned interpreter instead. With that interpreter gone there is nothing to re-exec into, and the banner comes back with the fix still in place. Re-pin, naming a Node that exists: `"<that node>" <checkout>/dist/cli.js setup`. `hive doctor` reports the same thing from the other side, on its dispatcher line.
- `No version is set for command hive`, or `hive: command not found` in one repo but not another: you are getting `npm link`'s shim, which only exists under the Node version that was active when you linked. Run `hive setup` and put `~/.local/bin` ahead of your version manager's shims.
- "This session cannot receive wake-ups: it is not running inside tmux": the lead was started with bare `claude` instead of `hive`. Start it with `hive` (or inside tmux) and wake-ups deliver.
- An idle background iTerm window after attaching (control mode only): enable the gateway bury setting from Setup. Don't close that window by hand; it detaches the session. `hive setup --attach raw` avoids this window entirely, since it never runs a control-mode client.
- `npm warn allow-scripts   better-sqlite3@13.0.3 (install: node-gyp rebuild)`: npm 11 lists install scripts it has not been told about. `package.json`'s `allowScripts` already carries a decision for this one, so the warning means that decision no longer matches the installed version. A bump re-requires it, deliberately. Edit the entry to the new version rather than running `npm approve-scripts`, which writes `true`; this project ships `false`. If you are on a platform with no prebuild, `true` is the entry you want, because there the script is the only thing that produces an addon.
- Claude writes todos or kv to the wrong store: two MCP servers with overlapping tool names are loaded in one session. See the MCP scope note in Setup.

## Tools (44)

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
| `project_prune` | Deletes every registered project that owns no rows anywhere in the store, after checking each individually; never your own | Sweeping stray projects a scratch spawn or a cwd change registered on its own |
| **agents** | | |
| `agent_spawn` | Starts a worker (default `claude`) in a tmux pane or window, locked to the project | One worker per parallel work stream; a `claude` worker briefs itself, so send it the assignment directly |
| `agent_list` | Lists this project's agents with live status | Morning triage, or before spawning more |
| `agent_status` | One agent in detail, with a short terminal tail | To check on a specific worker |
| `agent_send` | Types text or key presses into a worker's terminal | To give a worker its task, answer a prompt, or press Enter/Escape for it |
| `agent_output` | Reads the worker's rendered terminal, up to 200 lines | To read real results before calling a lane done |
| `agent_rename` | Changes a worker's display name; `actor_id` stays the same | When a worker's job becomes clear after you started it |
| `agent_resume` | Resumes a closed claude worker from its recorded session id (`claude --resume`), reusing the same actor_id | To get a closed worker's full prior context back instead of briefing a fresh one |
| `agent_park` | Parks a claude worker for the night: closes the pane, marks the row parked rather than plain closed, records the branch, and hands back a board line | End of day, when the lane is paused rather than finished and you want it back tomorrow |
| `agent_close` | Kills the worker's window and marks it closed. Called on a PARKED row (by `agent_id`) it releases the park instead | After capturing handoffs; terminal output is not retained. Also how you abandon a parked lane you have decided not to resume |
| **wake-ups** | | |
| `wake_set` | Types its body into a terminal after a delay, as a fresh user turn | Delayed or repeating check-ins; write the body self-contained (ids, context, next action) |
| `wake_when_idle` | Fires when workers go idle, using exact hook state. `scope="project"` is a standing watch over the whole crew that keeps watching and covers workers spawned later; `agents=[...]` is a one-shot over a named list | The lead's main loop: dispatch, set the standing watch once, go quiet; never poll |
| `wake_list` | Lists pending wake-ups, plus recently delivered ones with their typed/held/confirmed state | To see what is scheduled, and whether a fired wake actually landed |
| `wake_get` | Reads one wake-up by id, with its untruncated body | To see exactly what a wake will say, past `wake_list`'s 120-char cap |
| `wake_update` | Edits a pending wake-up you own in place, keeping its id | To reschedule (`delay_seconds`, relative to now) or edit the body/repeat interval without cancel-and-reset |
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
| `todo_archive` | Retires a todo but keeps it readable by id, or unarchives with `archived=false`; refuses if it still blocks non-completed work | Hiding a closed lane's scaffolding from `todo_list` without losing its comments |
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
| **actors** | | |
| `actor_prune` | Deletes every actor that owns no rows anywhere in the store, after checking each individually; never your own | Sweeping stray or one-off actors; unlike every other tool here, the scan is store-wide, not scoped to the current project, since actors carry no `project_id` |

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
| `HIVE_PROJECT_PATH` | Set automatically by `agent_spawn`: the worker's project path, checked against its project pin (looked up from its `agents` row) as a guard against a store swapped underneath a live worker | unset |
| `HIVE_AUTO_ATTACH` | `auto`, `on`, `off`, or legacy `0`: a one-off testing override for stored auto-attach. Not the configuration mechanism -- use `hive setup --auto-attach` | unset |
| `HIVE_ATTACH_MODE` | `auto`, `raw`, or `control`: a one-off testing override for the stored attach mode. Not the way to configure this -- use `hive setup --attach` for that. It does not reliably reach auto-attach, which runs inside the MCP server process, so setting it in your shell will not change what a spawned worker's terminal pops open in | unset |
| `HIVE_SPAWN_PLACEMENT` | `split` (workers tile as panes in the lead's window) or `window` (tab per worker) | `split` |
| `HIVE_SPAWN_READY_MS` | How long `agent_spawn` waits for a worker's prompt box before typing its `[hive]` line. On timeout the line is skipped, not sent blindly; the worker's brief is unaffected either way | `45000` |
| `HIVE_TMUX_TIMEOUT_MS` | How long any tmux call may take before hive kills it and reports the target's liveness as UNKNOWN (never as gone). A one-off testing override for a measured bound; `hive doctor` reports it when set, because a knob that shortens a safety bound must not sit in an environment silently. Raise it (never lower it) on a machine where legitimate tmux calls are slow | `10000` |
| `HIVE_BIN_DIR` | Overrides where `hive setup` writes and PATH-checks the dispatcher shim | `~/.local/bin` |
| `HIVE_LEAD` | Set to `1` by `hive lead` so the SessionStart kickoff hook still fires for the lead's own session even though `HIVE_AGENT_ID` is also set (the lead has an `agents` row too) | unset |
| `HIVE_ALLOW_DEFAULT_STORE` | Set to `1` to let a process that is not hive's own CLI, MCP server, or hooks open the real store (`~/.hive`) anyway. For a human's deliberate one-off against live data, not for a script or a driver you spawn: point those at `HIVE_DATA_DIR` set to a scratch directory instead, and pass it to every process the run spawns. Cannot override the test-runner refusal, which is checked first and always wins | unset |

## Development

```bash
npm run build    # compile to dist/
npm run watch    # compile on change
npm test         # run the suite against dist/ (build first)
```

Tests use Node's built-in runner and exercise the real MCP server and CLI as child processes against scratch data directories. CI (`.github/workflows/ci.yml`) runs build plus tests on macOS for every push and pull request.

Smoke test without touching your real data:

```bash
HIVE_DATA_DIR=/tmp/hive-test node dist/index.js
# then speak JSON-RPC on stdin, or just register it with Claude Code
```
