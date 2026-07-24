// A function so the topic list is derived from HELP_TOPICS (defined below)
// and cannot drift.
export function helpOverview(): string {
  return `HIVE — shared memory and coordination across Claude Code sessions

Many workers, one shared memory. Multiple Claude sessions (and humans) share
one project-scoped state store: pads, todos, kv, leases.

Call help(topic="<name>") for details. Topics: ${Object.keys(HELP_TOPICS).join(", ")}.

Scope resolution for project-scoped tools:
  pass project_id for a one-off override
  otherwise hive uses the project selected in this session
  otherwise it auto-detects from the working directory, or auto-selects a
  single registered project

Quick start:
  1. whoami — see your actor id and effective project
  2. pad_list / todo_list — see what other sessions have shared
  3. help(topic="workflow") — the lead/worker operating pattern

PLAYBOOKS — invokable prompts (slash commands in MCP clients)
  triage — morning ritual   orchestrate — lead/worker pattern
  wrapup — end of day

AGENTS — spawn and drive worker sessions in tmux
  agent_spawn, agent_list, agent_status, agent_send, agent_output, agent_close

WAKE-UPS — scheduled nudges instead of polling
  wake_set, wake_when_idle, wake_cancel, wake_list

PADS — shared documents (plans, findings, handoffs)
  pad_write, pad_read, pad_append, pad_edit, pad_list, pad_archive, pad_delete

TODOS — shared task tracking with dependencies
  todo_create, todo_list, todo_get, todo_update, todo_complete,
  todo_comment, todo_block, todo_unblock

KV — small shared status values (with optional TTL)
  kv_set, kv_get, kv_list, kv_delete

LEASES — advisory expiring claims on shared work areas
  lease_acquire, lease_release

PROJECTS — scope management
  project_list, project_add, project_select`;
}

export const HELP_TOPICS: Record<string, string> = {
  workflow: `WORKFLOW — lead/worker orchestration

One session acts as the lead. It spawns and drives workers with the agent
tools; each worker is its own agent CLI session in a tmux window, locked to
this project.

If a pad named "runbook" exists, read it first. It is this project's
tailored version of this pattern and takes precedence. hive init seeds a
starter runbook.

The operating pattern:
  1. Interview the human until you can write a real plan.
  2. Write the plan to a pad: pad_write(name="plan", ...). Include the goal,
     code paths, constraints, parallel lanes, and verification steps. The
     pad is the shared memory for the run. Keep it current.
  3. Convert the plan into todos. One todo per lane. Name the files each
     lane owns and its acceptance criteria in the body.
  4. Encode ordering with blockers: todo_block(todo_id, blocker_id). Workers
     pick up work with todo_list(is_blocked=false, status="open").
  5. Spawn one worker per unblocked lane: agent_spawn(name="api-worker").
     For parallel file edits, give each worker its own git worktree via cwd.
     PREPEND the returned instructions to the first agent_send prompt, then
     state the lane's objective, its pad/todo ids, and file ownership.
  6. Workers set status="in_progress", do the work, then todo_comment the
     handoff: changed files, tests run, remaining risk. Then todo_complete.
     Completing returns newly_unblocked todo ids.
  7. Do not poll. Set wake_when_idle(agents=[...], body="...") and go
     quiet; hive wakes you when a worker goes idle. Read REAL output
     (agent_output) before declaring a lane done. The human can watch live
     with tmux attach -t hive-<project_id>.
  8. The lead reviews real diffs and output, not just summaries, then
     integrates one lane at a time.
  9. Capture handoffs in pads/todo comments BEFORE agent_close; terminal
     output is not retained.

Manual workers still work too: a human can open a window and run
  HIVE_AGENT_ID=worker-1 HIVE_AGENT_NAME="API worker" claude

Rules that keep this sane:
  - Keep worker prompts self-contained: include pad and todo ids.
  - Record every decision in the pad or a todo comment. Sessions die;
    the store survives.
  - Take a lease (lease_acquire) before editing a shared file area; leases
    expire so a dead session never wedges anyone.`,

  agents: `AGENTS — spawn and drive worker sessions in tmux

  agent_spawn(name?, model?, command?, extra_args?, cwd?, placement?) —
    start a worker (default command: claude) in session hive-<project_id>.
    placement="split" (default) tiles the worker as a pane in the lead's
    window so the whole crew shares one screen; placement="window" gives it
    its own tmux window (iTerm tab). Projects can set a default placement
    in hive.yml; an explicit argument overrides it. cwd defaults to the project root; pass
    a git worktree path to isolate parallel file edits. Returns instructions
    to PREPEND to the first prompt. Workers run with HIVE_PROJECT_LOCK=1.
  agent_send(agent_id|name, text?, keys?, submit?, wait_ms?) — type into the
    worker's terminal. Multi-line text pastes safely; keys sends tmux key
    names like Escape or C-c. wait_ms returns the terminal tail after.
  agent_output(agent_id|name, lines?) — read the rendered terminal.
  agent_status(agent_id|name) — liveness, current command, short tail.
  agent_list(include_closed?) — all agents with live status.
  agent_close(agent_id|name) — kill the window and mark closed. Capture
    handoffs first; output is not retained. Self-close needs confirm_self.

Visibility is automatic: if nothing is attached to the project session when
a worker spawns, hive pops open iTerm (control mode) or Terminal attached
to it, so the human sees every worker as a native window and can type into
any of them. The human usually starts the day with the CLI: hive lead.
Manual attach also works: tmux -CC attach -t hive-<project_id>.

Worker state (agent_state on list/status) comes from Claude Code hooks that
agent_spawn wires automatically: working (prompt submitted), idle (finished
its turn), waiting (needs permission or input). Non-claude commands show
"unknown".`,

  wakes: `WAKE-UPS — scheduled nudges instead of polling

  wake_set(delay_seconds, body, deliver_to?, repeat_every_seconds?) —
    one-shot or repeating wake-up
  wake_when_idle(agents, body, mode?, max_wait_seconds?, deliver_to?) —
    fire when watched agents go idle. mode=any (default) fires on the first
    fresh idle transition; mode=all fires when every watched agent is idle
    and returns already_satisfied instead of scheduling if they already are.
  wake_cancel(wake_id) — cancel a pending wake-up you own
  wake_list() — pending wake-ups in this project

Delivery contract:
  When a wake-up fires, its body is typed into the target session's terminal
  as a fresh user turn, prefixed with [hive wake #N]. The receiving agent
  gets it cold, so write bodies self-contained: agent ids, pad/todo ids,
  and the next action. Plain English, no markup.

Receiving wake-ups:
  Spawned workers can always receive (deliver_to their name or id).
  A lead session can receive only if it runs inside tmux; start it with
  tmux, then claude (watch via iTerm: tmux -CC attach). Otherwise wake_set
  without deliver_to fails with guidance.

Idle detection is exact, not heuristic: Claude Code hooks in each spawned
worker report working/idle/waiting into the shared store the moment they
happen. Cancel wake-ups when the monitored work is done.`,

  projects: `PROJECTS — scope management

Every pad, todo, kv entry, and lease belongs to one project (a directory).

  project_list — all registered projects plus the current selection
  project_add(path?, name?) — register a directory (defaults to cwd)
  project_select(project_id) — set this session's default scope

Resolution order: explicit project_id argument, then session selection, then
working-directory auto-detection. When the working directory matches no
registered project, it is registered as a new project automatically; hive
never falls back to an unrelated project.

Git worktrees and subdirectories resolve to the primary checkout's project,
so a worker session in a worktree shares the main repo's pads and todos.
Register a worktree path explicitly with project_add to make it a separate
project on purpose.

Cross-project access is intentional-only. An empty result means there is
nothing in this project; report that and stop. Reach into another project
(project_select or a project_id override) only when the user explicitly
names it. Set HIVE_PROJECT_LOCK=1 in a session's environment to reject
cross-project access entirely; use it for worker sessions.`,

  identity: `IDENTITY — who is writing

Every write records an actor. Identity comes from environment variables read
at session start:

  HIVE_AGENT_ID    stable actor id, e.g. "worker-1" or "lead"
  HIVE_AGENT_NAME  display name, e.g. "API worker"

Without HIVE_AGENT_ID you are "user:<username>" (kind: human). Launch worker
sessions with distinct ids so handoffs and locks are attributable:

  HIVE_AGENT_ID=worker-1 claude

whoami shows your actor id, kind, and effective project.`,

  pads: `PADS — shared documents

  pad_write(name, content, tags?) — create a pad; names are unique per project
  pad_write(pad_id, name, content, expected_revision) — full overwrite; the
    revision guard makes concurrent writers safe
  pad_read(pad_id | name) — content plus revision and metadata
  pad_append(pad_id, content, expected_revision?) — add to the end
  pad_edit(pad_id, old_text, new_text, expected_revision?) — replace one
    unique literal occurrence; include enough context to disambiguate
  pad_list(query?, tags?, include_archived?) — summaries without content;
    query matches names and content and returns a snippet
  pad_archive(pad_id, archived?) — archive frees the name for a new active
    pad; content stays readable by pad_id. archived=false unarchives.
  pad_delete(pad_id, expected_revision?) — permanent; prefer pad_archive

Convention: read before you write. Reads return the revision; pass it back
as expected_revision so a concurrent edit fails loudly instead of clobbering.

Lifecycle: durable pads (a runbook, a daily board) get updated in place.
Temporary pads (a lane plan, a findings dump) get archived when their work
completes, like todos. Rotate a daily board by archiving yesterday's pad
and writing a fresh one under the same name; keep the live pad small,
since every read pays for its full length.`,

  todos: `TODOS — shared task tracking

  todo_create(title, body?, priority?, tags?, blocked_by?) — priority is
    high|medium|low
  todo_list(status?, is_blocked?, priority?, query?, tags?, limit?, offset?)
    — status is open|in_progress|backlog|completed; is_blocked=false finds
    dispatchable work
  todo_get(todo_id, include_comments?) — full body, blockers, comments
  todo_update(todo_id, title?, body?, priority?, status?, tags?)
  todo_complete(todo_id, completed?) — returns newly_unblocked todo ids;
    completed=false reopens
  todo_comment(todo_id, body) — handoffs, decisions, findings
  todo_block(todo_id, blocker_id) / todo_unblock(todo_id, blocker_id)

Blockers form a dependency graph (cycles are rejected). A todo is blocked
while any of its blockers is not completed.`,

  kv: `KV — small shared status values

  kv_set(key, value, ttl_seconds?) — value is any JSON; TTL optional
  kv_get(key)
  kv_list(prefix?)
  kv_delete(key)

Use kv for values another session needs to discover: current branch, a port,
a phase flag. Use pads for anything longer than a line or two.`,

  leases: `LEASES — advisory expiring claims on shared work areas

  lease_acquire(key, ttl_seconds) — non-blocking; returns the holder if
    already taken; re-taking your own lease extends it
  lease_release(key)

Keys are project-scoped and free-form; keep them stable and specific, like
"file:src/api/routes.ts" or "todo:42". Leases expire on their own, so a
crashed session never wedges the team.`,
};
