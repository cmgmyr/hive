# Daily driver

## A day with hive

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

## Starting a session

```bash
cd ~/Code/your-project
hive
```

`hive` (shorthand for `hive lead`) opens a `lead` window in this project's tmux session. Under iTerm it opens as a native window; run it under a different terminal, or prefer plain tmux, and it runs as a raw `tmux attach` instead. Detaching, or closing the window, leaves everything running; run `hive` again to reattach. `hive attach` does the same without opening a lead.

## Watching and taking over workers

Every worker the lead spawns shows up automatically, live, in its own window or pane. Watch or take over any of them from any terminal:

```bash
tmux attach -t hive-main      # plain terminal
tmux -CC attach -t hive-main  # iTerm native windows/tabs
```

`hive attach` runs one of these for you already. Open a second terminal and attach again: it gets its own view onto the same windows rather than fighting the first one over which window is showing.

If nobody is watching when a worker spawns, hive opens a terminal onto the session for you, so a worker starting up is never silent just because you closed your window. Turn this off with `hive setup --auto-attach off`. See [docs/tmux.md](tmux.md) for the full set of attach modes.

## Arranging the panes

Workers spawn as panes inside the lead's window by default, tiled evenly. Two knobs change that, each settable in `hive.yml`, per spawn, or (for placement) machine-wide:

- **Placement**: `placement: split` (default, panes) or `placement: window` (a tab per worker). `HIVE_SPAWN_PLACEMENT=window` sets it machine-wide.
- **Layout**: `layout: tiled` (default), `main-vertical`, `main-horizontal`, `even-horizontal`, or `even-vertical`. The `main-*` layouts give the lead a bigger pane and stack workers on the side.

hive re-applies the layout whenever a worker spawns or closes, so it holds up as the crew changes size.

## Workers

Spawn one with `agent_spawn`; it starts an agent CLI (default `claude`) in a pane or window, with its own identity and locked to the project. Type into it with `agent_send`, and read its terminal with `agent_output`. Spawning several workers on the same project shares one plan: for parallel file edits, give each its own git worktree with the `cwd` parameter, and everyone still reads and writes the same pads and todos.

## Wake-ups, not polling

Workers report their state (`working`, `idle`, `waiting`) the moment it changes, through Claude Code hooks. Set a wake-up and go quiet instead of checking in:

- `wake_when_idle(scope: "project")` is a **standing watch** over the whole crew: it tells you about each worker as it finishes, covers workers spawned after you set it, and keeps watching until you cancel it or it expires. Set it once per session.
- `wake_when_idle(agents: [...])` is a one-shot version over a named list; it stops watching the others once it fires.
- `wake_set` gives a plain delayed or repeating wake-up, for anything that isn't "tell me when a worker goes idle."

A fired wake-up types its body into your terminal as a fresh turn, prefixed `[hive wake #N]`. To receive one, a lead has to run inside tmux; leads started with `hive` always do.
