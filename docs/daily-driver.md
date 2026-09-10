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

hive re-applies the layout whenever a worker spawns or closes, so it holds up as the crew changes size. `agent_spawn`'s receipt names the layout it applied, so you can tell what hive chose without checking the panes by eye.

## Workers

Spawn one with `agent_spawn`; it starts an agent CLI (default `claude`) in a pane or window, with its own identity and locked to the project. Type into it with `agent_send`, and read its terminal with `agent_output`. Spawning several workers on the same project shares one plan: for parallel file edits, give each its own git worktree with the `cwd` parameter, and everyone still reads and writes the same pads and todos.

Pick a different harness per worker with `agent_spawn`'s `harness` parameter (`harness: "codex"`) or by naming the command directly (`command: "codex"`); leaving both unset spawns the project's `hive.yml` default, the first entry in its `agents:` list. A project has to opt codex into that list before either works, and a codex worker gives up some things a claude one has: no park or resume, no stall reporting, no context-percentage reporting. See [docs/install.md#codex-workers](install.md#codex-workers) for the full list and what opting in takes.

### A worker's long report reaches you as one line

Your lead's pane is your window, not a log. So when a worker sends a lead more than 300 characters of text, hive stores the message and types a single pointer line into that pane instead:

```
[hive:worker api] [message #7, 885 chars] BLOCKED: the migration test wedges on a
lock the sweep never releases, and I cannot get a clean red… agent_message_get(7)
for the full text.
```

You get who sent it, how much you are not being shown, the first 140 characters, and the call that hands back the rest. Read the whole thing with `agent_message_get(7)`.

Three things about it are deliberate:

- **Only messages to a lead are shortened, and only from someone who is not that lead.** Text sent to a worker is typed exactly as written at any length, because there the message IS the assignment, and a truncated assignment is a broken one.
- **A short message is never touched.** Under 300 characters it lands whole, so "I am blocked, the machine is wedged" still arrives complete and actionable with no lookup. The threshold sits in the gap between the two real populations: the longest messages anyone writes by hand run to about 140 characters, and worker reports start around 440.
- **The sender is told.** `agent_send`'s receipt comes back with `shortened: true`, the message id, and a note saying to put whatever needs acting on in the first 140 characters or on the todo. A worker cannot keep writing 900-byte reports believing you read them.

Messages are kept for 7 days. The pointer line stays in your scrollback longer than that, so a lookup for an expired id tells you it expired rather than reporting it missing, and points you at the todo or pad the sender wrote instead.

## Permission mode

hive does not set a permission mode. A worker inherits whatever mode Claude Code's own configuration gives it at the moment it spawns, fixed for that session: hive passes no `--permission-mode` flag and has no `hive.yml` key for one. These docs go no higher than `auto`; hive itself never raises the mode for you.

hive does say what a worker inherited, once it can: `agent_status` and `agent_list` report a `permission_mode` field, and `hive doctor --verbose` prints the same value on each worker's line. All three read it off the worker's own hook payloads, so it is unset until the worker's first prompt or stop, and stays unset for a worker that never gets one.

Whether a worker on `auto` ever stops depends on two things together, not the mode alone: the mode and your own permission allow list (the `permissions` block in `~/.claude/settings.json`, or a project's own settings). A broad allow list can mean `auto` never prompts at all; a narrow one stops sooner. A worker that stops on a prompt is a modal pane, not a crash: it stops until someone answers it.

Answer it by hand: attach (see [Watching and taking over workers](#watching-and-taking-over-workers) above) and respond in the worker's own pane. From outside the pane, `agent_send`'s `text` refuses on a dialog rather than typing into it, returning the pane's tail so you can read the prompt; `agent_send`'s `keys` is the supported way to drive it from outside instead, deliberately left unguarded, because pressing a key is the only way to unstick a dialog from outside the pane.

Arm a standing watch before you spawn workers, on any mode that can prompt: `wake_when_idle(scope: "project")`. It reports a worker stopped on a permission prompt to the watch's owner, always, overriding wherever else the watch delivers. A plain idle report goes to the watch's own delivery target instead, so the two land in the same place only if you never set one. With no watch armed, nothing is pushed to you: `agent_list` shows the worker in state `waiting`, and `hive doctor --verbose` prints its pane tail (prompt text included) plus the permission mode itself, so you don't have to reconstruct it from the prompt text.

## Wake-ups, not polling

Workers report their state (`working`, `idle`, `waiting`) the moment it changes, through their own CLI's hooks. Set a wake-up and go quiet instead of checking in:

- `wake_when_idle(scope: "project")` is a **standing watch** over the crew you spawn: it tells you about each worker as it finishes, covers workers spawned after you set it, and keeps watching until you cancel it or it expires. Set it once per session. It reports the workers *you* spawned, not every agent in the project, so a throwaway probe one of your workers spawned for itself stays out of your pane.
- `wake_when_idle(agents: [...])` is a one-shot version over a named list; it stops watching the others once it fires.
- `wake_set` gives a plain delayed or repeating wake-up, for anything that isn't "tell me when a worker goes idle."

A fired wake-up types into your terminal as a fresh turn, prefixed `[hive wake #N]`. To receive one, a lead has to run inside tmux; leads started with `hive` always do.

What gets typed depends on who is receiving it. **A worker gets the body verbatim**, always, because the text in a worker's pane is your record of what it was told - the assignment, the reframes, the corrections. **A lead gets crew state**: a standing watch's finish notice is typed as one line per worker, in the state hive reads as it delivers, and the workers that have not reported are a tally at the end:

```text
[hive wake #752] docs-lane: idle.
t455-render: idle.
3 others still going. wake_get(752) for detail.
```

That is one line per WORKER, not one per finish. A worker that finished four turns while the notice sat held is named once, and a worker that has already picked up new work reads as working rather than being counted a second time in the tally. The per-episode roster, the still-going list and the watch's own body are all still stored on that notice; `wake_get(752)` returns them unchanged. A blocked worker is the exception and keeps the long form, because that wake is the only thing that will ever tell you a worker is stopped on a permission prompt.

**A worker that backgrounded something and then ended its turn is reported as idle with what it left running,** because the two are not the same thing:

```text
[hive wake #863] t462-outputschema: idle, 1 background shell running - may not be done.
Nothing else is running. wake_get(863) for detail.
```

That worker really is idle, so the watch still speaks and you still get control back. It had also just started `npm run build && npm test` and stopped to wait for it. Read its pane before you act on the line. A background shell, a monitor, or anything else Claude Code runs in the background counts; a subagent does not appear here, because a worker waiting on one of those never reads idle in the first place.

### hive holds a wake while you are talking

If a human message reaches a lead in the last five minutes, a wake bound for that lead **waits** instead of landing mid-conversation. A notice that waited that long says so when it lands, in one line; below that, the hold is too short to have made anything stale and hive stays quiet about it. It is a submitted turn that counts, not text sitting in the box - unsent text is the separate `typing` hold. Tagged `agent_send` deliveries and hive's own wake deliveries are excluded, so crew reports do not hold a lead's wakes. Nothing is lost or cancelled: the scheduler re-checks every few seconds and delivers once you have been quiet for the window, and `hive statusline` shows the hold as `1 held (2m, talking)` while it lasts. If more than one worker finishes during that time, they merge into a single notice rather than queueing up.

A hold of any kind that lasts more than an hour is the one case where a finish notice does not arrive as written. hive will not type an hour-old "your worker finished" as news, so it cancels that notice - and tells you it did, in a line naming the workers it covered and pointing at `wake_get` on the cancelled notice, which still holds the full text. You lose the timing, never the fact.

So a wake arriving minutes later than you expected, while you are mid-thread with a lead, is the hold working rather than a stall. Two bounds keep it honest: the window refreshes on each thing you say, and a wake is never held more than fifteen minutes past its due time however long you keep talking.

Under a `/goal` the lead takes its own turns without anyone prompting it, so nothing refreshes the window and the hold stays out of the way. Human conversation still refreshes it, while tagged worker reports do not, so an unattended run's crew can report without delaying each wake.
