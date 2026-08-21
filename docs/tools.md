# Tools (44)

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
| `wake_when_idle` | Fires when workers go idle, using exact hook state. `scope="project"` is a standing watch over the crew you spawn in this project that keeps watching and covers workers spawned later; `agents=[...]` is a one-shot over a named list | The lead's main loop: dispatch, set the standing watch once, go quiet; never poll |
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
