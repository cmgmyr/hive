# Projects

Setting a project up, `hive.yml`, the store's automatic backups, and reaching pads and todos from the shell.

## Runbook and board (`hive init`)

`hive init` sets a project up. It writes a starter `hive.yml`, asks which profile the project should use (or takes `--profile <name>` / `--no-profile`), and seeds the `board` pad, the live picture of the work.

When you pass a path, `hive init` registers the git checkout containing that path, or the path itself when it is not in a checkout. It can register a new project below an existing registration and reports the ancestor so you know which registration is deepest.

A project **with** a profile reads its process from `hive runbook` and gets no runbook pad; a second copy in the store would only go stale. A project on `profile: none` gets the `runbook` pad instead, seeded with a starter template whose first-run section has the lead interview you (how work arrives, branch and PR rules, worktree setup, how workers verify, what needs explicit approval) and rewrite it to fit. Either way `hive runbook` prints the right one.

After that, opening the lead with "good morning, let's triage" is enough; every hive session is instructed to read the standing process before orchestrating. The server also exposes one prompt, which Claude Code surfaces as a slash command: `/mcp__hive__runbook` loads whatever this project's runbook says. hive registers nothing beyond that on purpose. A prompt reaches every user of every project, so a routine that belongs to one team's way of working belongs in that project's runbook or its profile, not in the server.

The board holds today's lanes, what's waiting on you, and what's next up. The runbook instructs the lead to update it the moment tasks change (todos created, re-scoped, blocked, completed; lanes started or finished), keep it small, and at day end `pad_archive` it and write a fresh one under the same name. Archiving frees the name and keeps history readable via `pad_list(include_archived=true)`.

## Project commands (hive.yml)

Define a project's dev processes and lead in a `hive.yml` at the project root; `hive` starts them with the session:

```yaml
lead: claude --model opus     # optional command for the lead window
placement: split              # optional placement for workers and visible processes: split
                              # (panes, default) or window (tabs)
layout: main-vertical         # optional pane arrangement for split: tiled (default),
                              # main-vertical, main-horizontal, even-horizontal, even-vertical
agents: [claude, codex]       # optional allowed harness set for spawned crew; first entry is
                              # the default. Absent or empty means claude only, and agent_spawn
                              # REFUSES a harness or command outside this list. lead: above is a
                              # separate key and stays reachable regardless of this list.
context_checkpoint_percent: null # unset means off; integer 1-100 to enable
review_tags: [from-review]    # optional todo tags `hive doctor` counts as review findings and
                              # reports as triaged (a comment, completed, or archived) or
                              # untriaged. A tag also matches its own suffixed rounds, so
                              # from-review covers from-review-3. Absent means doctor tracks
                              # none and says so; hive ships no tag names of its own.
dashboard: true               # optional; default false. Writes a generated, auto-refreshing
                              # HTML dashboard to .hive/dashboard.html on every tick (see [the dashboard guide](dashboard.md)):
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
    visible: false            # optional; default true. true follows placement: above, the
                              # same as a worker (split beside the lead, or its own window).
                              # false tiles it as a pane in one shared `<project>/processes`
                              # window instead, so N background processes cost one tab.
    env:
      NODE_ENV: development
```

Commands appear as windows in the session (visible in iTerm like everything else) and show up in `agent_list`, so the lead can read their output with `agent_output` - that works for a process exactly as it does for a worker, including a hidden one, so you can read a dev server's log without putting it on screen. Because the file is repo-controlled, each command runs only after you approve it once interactively; changing a command in any way requires re-approval, and `dir` cannot escape the project root. Unknown keys are ignored, so configs from similar tools parse after a copy.

### Worker context checkpoint

Set `context_checkpoint_percent` to an integer from 1 through 100 to notify workers when their context fill reaches that percentage. An absent key or `null` disables the hook. Invalid values are ignored with a warning. Hive sends a factual context reading once per upward crossing; it does not stop the worker or prescribe an action. A below-threshold observation after compaction allows another crossing.

The value is captured in the worker-only `HIVE_CONTEXT_CHECKPOINT_PERCENT` environment variable when a worker spawns or resumes. Editing `hive.yml` affects the next spawn or resume, not a running worker. This setting applies to Claude and Codex workers only. It has no `agent_spawn` argument and does not instrument the lead.

### Background processes (`visible: false`)

A visible process follows `placement:` exactly like a worker does: beside the lead under the default `split`, or its own tab under `placement: window`. Set `visible: false` instead and the process tiles as a pane in one shared `<project>/processes` window per project, so six background processes across two projects cost two tabs, not six.

Visibility is not part of what hive approves. Toggling `visible` never re-opens the trust prompt, because the command hive runs is unchanged; only its name, its command, its `dir` and its `env` are hashed.

Two commands move a running process between the two places:

```bash
hive show queue:work    # move its pane beside the lead
hive hide queue:work    # move it back into <project>/processes
```

Neither restarts anything. The pane keeps its process, its pid and its scrollback; only its window changes. While it is in the group its pane is titled `<project>/processes · <name>`, and beside the lead it is titled `<project>/<name>`, so a tmux status line that renders the pane title tells you which process you are looking at either way.

Where a process is showing is derived from tmux every time it is asked, never stored: tmux destroys a window when its last pane leaves, so the `<project>/processes` window comes and goes as you show and hide the last tile. `hive hide` recreates it when it is gone.

One case does not tile. If a `visible: false` process is the thing that opens the project's tmux session, it takes that session's first window, because a session's first window belongs to whoever created it. `hive start` says so and tells you the `hive hide` that moves it in.

`hive status` labels each running process `shown` or `hidden`, `hive doctor` reports one line counting them, and the dashboard gets a Processes card and section listing every process the project defines - running or not - with its state, where it is showing, and when it started.

`agents:` needs no such approval, and that's deliberate rather than an oversight: unlike `processes:`, which carries an arbitrary string hive executes, each `agents:` entry is checked against hive's own fixed table of known harnesses at parse time and dropped with a warning if it isn't one - the repo can only ever pick among names hive's code already recognizes, never smuggle in a command of its own. `agent_spawn`'s `harness` and `command` parameters are gated the same way: a command that resolves to a known harness (by basename) not in this list is refused; a command hive doesn't recognize as any harness at all was never part of this pool and is unaffected by it.

### Process lifetime

A process never outlives the lead that owns the session unless you chose that. Four things stop one, and each names its own reason:

| What happened | Reason hive records |
|---|---|
| You ran `hive stop <name>` or `hive stop --all` | `hive stop` |
| You ended the lead's session cleanly: `/exit` or a logout for claude, `/quit` or Ctrl-C twice for codex | `lead session ended` |
| The lead's own process died: a crash, a signal, or you quit it | `lead pane exited` |
| A fresh `hive lead` found processes a previous lead had left running | `left running by a previous lead` |

Each harness gets its own allowlist of reasons that count as the session ending for good, because their vocabularies do not overlap. For claude, only `/exit` and a logout count, the two reasons Claude Code documents as the session being over. Everything else is treated as the lead still being there; `/clear` is the obvious one, since it ends the session and starts a new one in the same pane, so that lead still owns its processes. For codex, the only reason ever observed is the one both its quit command and Ctrl-C twice send; codex has no `/clear` equivalent. Being careful here costs nothing, since a lead whose pane really died is covered by the tmux hook instead, the `lead pane exited` row above.

If you exit a lead cleanly and then start it again in that pane by hand, its processes are already stopped and nothing brings them back: only `hive lead` starts them. Start them with `hive start <name>`, or restart the lead through `hive lead` and let it do it for you.

Workers are never stopped by any of this, deliberately. You often want to finish with a worker after the lead is closed, so closing a lead takes down its processes and leaves its crew alone.

A stop is graceful first: hive types C-c into the pane, waits two seconds for the process to exit, and kills the pane only if it is still there. The receipt says which one ended it, so `stopped` never covers for a process that is still holding its port:

```bash
hive stop npm:dev     # npm:dev: stopped (C-c)
hive stop queue:work  # queue:work: stopped (killed after 2s)
hive stop --all       # one line per running process
```

The two automatic paths cover different deaths, and you need both. The session-end hook covers a session that ends cleanly, and both harnesses have it: claude fires it through its own `SessionEnd` hook, codex through the same event on its own lead home. The tmux hook covers a process that dies without ending its session, for both harnesses alike.

One gap is worth knowing about. tmux fires nothing at all for a pane destroyed with `tmux kill-pane`, so a process survives that until something else stops it. The documented restart path, `scripts/restart-lead.sh`, kills the lead pane and then runs `hive lead`, and that `hive lead` is what stops the leftovers and starts them again. If you kill a lead pane by hand and do not restart it, clear its processes with `hive stop --all`.

A fresh `hive lead` reports what it found:

```
- npm:dev: stopped (C-c); left running by a previous lead
- npm:dev: started (hidden)
```

Re-running `hive lead` while the lead is alive adopts that pane and stops nothing, because those processes belong to the lead that is still running.

A process that dies on its own tells the lead so, once, naming the command that restarts it. A process you stopped says nothing. What tells the two apart is a short-lived marker hive writes before it touches the pane, so an interrupted stop is not reported as a crash either.

A stop that cannot finish says so rather than pretending. If the process survives both C-c and the kill, you get `<name>: still running: its pane survived C-c and kill-pane, so hive left the row open` and the process stays visible to `hive status` and to the next `hive stop`.

### Choosing `review_tags`

`review_tags` names todo tags that already mean something in your project. hive applies none of them: a finding becomes a review finding because whoever filed it tagged the todo, by hand or from whatever review step your process runs. So pick the names your process already uses, and if it does not tag findings at all, leave the key out - hive ships no tag names of its own, and an absent `review_tags` is the honest state for a project with no review pipeline rather than a gap to fill.

What the check does with them: `hive doctor` counts every todo carrying one of those tags, or a suffixed round of one (`from-review` covers `from-review-3`), and splits them into triaged and untriaged. Triaged means the todo has at least one comment, or is completed, or is archived - any comment counts, on the theory that a decision you wrote down is a decision you made. Untriaged findings get a warning naming each todo by id.

It is a reminder, never a gate. That warning is non-gating, so `hive doctor --strict` does not fail on it. What it catches is a finding that was filed and then never answered, which happens quietly and is cheap to fix once someone sees the id.


## Automatic backups

The store backs itself up automatically: a snapshot before any pending schema migration runs, and one an hour while any hive session is open, rate-limited so five concurrent sessions still produce one backup, not five. Snapshots are consistent `VACUUM INTO` copies, not file copies, which matters because hive runs in WAL mode: a plain copy of `hive.db` can silently miss everything sitting in the WAL since the last checkpoint. Each snapshot is built in a private staging directory and only renamed into place once complete, so a crash mid-backup never leaves a truncated snapshot that looks valid.

`hive backups` lists them with size and age. `hive restore <name>` overwrites the live store from one, prints exactly what it is about to replace, takes one more snapshot of the current store first, and refuses without an explicit `[y/N]` confirmation or `--yes`. It also refuses while any agent is recorded as running or a hive tmux session is still up, since replacing the database out from under an open connection is undefined behavior in SQLite; pass `--force` if you are certain nothing is using the store. Retention keeps the last 10 snapshots plus one per day for a week by default (`HIVE_BACKUP_KEEP_LAST`, `HIVE_BACKUP_KEEP_DAILY_DAYS`, both floored so a backup can never prune itself away), and `hive doctor` reports the count, total size, and whether the last attempt failed or the last success is more than `HIVE_BACKUP_STALE_DAYS` (default 7) old.

## Pads and todos from the shell

Pads are reachable from the shell too, without spending a Claude turn: `hive pads` lists them, `hive pad <name>` prints one, and `hive pad <name> --edit` exports it to a temp markdown file and opens your system's default markdown editor (override with `HIVE_EDITOR=zed` or similar). Edit, save, then `hive pad <name> --save` writes it back. The export encodes the pad revision, so if a session changed the pad while you edited, the save fails with merge instructions instead of clobbering; your edits stay in the temp file. Temp exports live in the system temp dir and clean themselves up on save (macOS purges strays automatically).

Todos are reachable from the shell too: `hive todos` lists the current project's todos, open work by default (`--all` for everything, `--status <s>` for one status, `--tag <t>` for one lane), marking blocked items so you don't pick up something that can't start yet. `hive todo <id>` prints one todo in full, comments included and never truncated, since a worker's handoff is often the only record of what it did. Both commands are read-only and silent outside a hive project; creating, completing, and commenting stay MCP-only for now.
