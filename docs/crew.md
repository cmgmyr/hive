# Crew sidebar

`hive crew --json` prints one read-only JSON snapshot of this project's crew. The `lead_sidebar` key turns it into a pane inside a Claude lead. Both are off until you ask: with the key absent, a lead starts exactly as before.

## Turn it on

```yaml
lead_sidebar: true
```

Restart the lead (`hive lead`). A Claude lead then starts with `--plugin-dir` pointing at the bundled `claude-plugin/crew` mod, which resolves relative to the installed `dist/`, so it follows the version you installed. Codex leads, lead commands hive does not recognise as Claude, and workers never get the flag. `false` and `null` both mean off. A value that is not a boolean warns and keeps the previous value.

At session start the pane opens by itself only in a terminal 144 columns wide or more, because Claude Code places an unasked pane from that width. Run `/hive-crew` in the lead to open it from 110 columns; it then docks at the right. Below 110 columns it opens inline above the prompt. Inline, the pane clips after about twelve rows (about five lanes), so the header line carries the needs-you count, and a failed read shows right under it. The footer, with the next wake, can fall below the clip inline. A crew larger than that loses its lower rows inline; docked, it has the full height. The zoomed layout was not machine-captured; check it by eye.

## What a row shows

One row per running worker in this project, in worker id order, then one row per in-progress todo that has no running worker. Line one is a state dot, the todo id and the todo slug. Line two is the model (the harness name when the model is unknown), then the state or activity with how long it has lasted, `ctx` percent, the worker's age, and `+N commits` when known.

The dot is red when the worker is blocked on a dialog, yellow when it is your turn, green when it is working, gray otherwise. `ctx` turns amber at `context_checkpoint_percent`. A worker with no todo link shows `--` and `<name> unlinked`; the mod never guesses a todo from a worker's name. Pass `todo_id` to `agent_spawn` so the link exists. Without it you see the worker as unlinked and its todo as unstaffed. Two workers on one todo are two rows.

The footer is built from the wake's fields, not its free-prose body. `next in 12m: <label>` shows the next wake with its countdown, a notice from a watch or wake (a wake with a parent) reads `crew notice`, and a held wake reads `held (talking)` or another short reason instead of a countdown. `watching: all workers · standing · until 02:35` shows a standing watch. When workers are running and neither a standing watch nor a pending one-shot idle wake covers any of them, an amber `unwatched` line says so. A standing watch is never counted as pending.

## `hive crew --json`

It prints one object: `schema_version` (1), `project`, `read_at`, `lanes`, `needs_you`, `wakes` and `context_checkpoint_percent`. Every key is always present; missing telemetry is `null`. Dates are UTC ISO strings. `test/crew.test.mjs` pins the exact key sets, and the mod's tests run against the real output.

- It runs `SELECT`s only. It starts no janitor, registers no actor and writes nothing to the store. It never migrates: a store without `agents.todo_id`, an unregistered directory or a bad argument exits 1 with a remedy on stderr and no JSON.
- `lanes[].worker.activity` is read from the tail of the worker's own transcript (at most 256 KiB and the newest eight tool calls) and never from another session's file. A worker with no recorded transcript path reports its stored state.
- Tool calls map to labels: reading, editing, reviewing, committing, testing, building, installing, or `running <word>`. Your project's `vars` come first: `test_one` is `testing`, `test_all` is `testing full suite` (a `test_all` command with forwarded file arguments also reads as the full suite), `check` is `building`, `install` is `installing`. `vars.review_skills` is a comma-separated list of skill names that mark `reviewing`; absent or empty means no skill-name matching. Generic node, PHP and Taskfile commands label as testing or building without `vars`. Anything else is `running <first word>`. The classifier never runs a command.
- `activity` keeps the last call while a worker is idle; the mod shows the state first and the activity second. `since` is the oldest timestamp in the trailing run of one label, and `lower_bound` is true when that run reaches the oldest call read. The mod shows `>=` for a lower bound and `~` for a time it observed itself.
- A worker whose stored state is `waiting` is checked for a dialog only when its pane is live and owned by that worker; only then is it `blocked`. Any other result stays `waiting`.
- `your_turn` is idle and past its first prompt. It says nothing about the todo being done.
- `commits_ahead` counts commits in a linked git worktree beyond the local default branch, using local refs only. It is `null` for the main checkout, a missing ref or a timeout. There is no fetch and no network.
- There is no lane phase. hive does not infer "planning" or "in review" from names or comments.

## The mod

`claude-plugin/crew/model.mjs` holds all logic and is tested under `node:test`. `hooks/register.tsx` only owns the pane state, the clock and the JSX. The mod reads nothing but one `hive crew --json` call every five seconds (4000 ms timeout, run in the session's working directory) and a start-up check of `HIVE_LEAD`; if that is not `1` the mod registers no command and never polls or opens a pane, so a global install of the plugin does nothing inside a worker. A failed, slow or malformed read keeps the last good rows and adds a `read failed` line. If the very first read fails there are no rows to keep, so the pane shows only the `read failed` line and `no data yet`. A schema version other than 1 is a failed read.

Older servers: `agent_spawn` refuses the `todo_id` parameter until the MCP server restarts onto the new build.
