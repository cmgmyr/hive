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
  agent_spawn, agent_list, agent_status, agent_send, agent_output,
  agent_rename, agent_park, agent_resume, agent_close

WAKE-UPS — scheduled nudges instead of polling
  wake_set, wake_when_idle, wake_get, wake_update, wake_cancel, wake_list

PADS — shared documents (plans, findings, handoffs)
  pad_write, pad_read, pad_append, pad_edit, pad_list, pad_archive, pad_delete

TODOS — shared task tracking with dependencies
  todo_create, todo_list, todo_get, todo_update, todo_archive,
  todo_complete, todo_comment, todo_block, todo_unblock

KV — small shared status values (with optional TTL)
  kv_set, kv_get, kv_list, kv_delete

LEASES — advisory expiring claims on shared work areas
  lease_acquire, lease_release

PROJECTS — scope management
  project_list, project_add, project_select, project_prune

ACTORS — who is writing
  actor_prune`;
}

export const HELP_TOPICS: Record<string, string> = {
  workflow: `WORKFLOW — lead/worker orchestration

One session acts as the lead. It spawns and drives workers with the agent
tools; each worker is its own agent CLI session in a tmux window, locked to
this project.

Read the standing process first: run \`hive runbook\` in a shell. It prints
the project's profile runbook, or its runbook pad when the project has no
profile, with hive.yml vars resolved. Whatever it says takes precedence over
this generic pattern.

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
     A claude worker briefs itself: hive loads the brief into its system
     prompt. Send the lane's objective, its pad/todo ids, and file ownership
     directly. Only a
     non-claude worker needs the returned instructions prepended.
  6. Workers set status="in_progress", do the work, then todo_comment the
     handoff: changed files, tests run, remaining risk. Then todo_complete.
     Completing returns newly_unblocked todo ids.
  7. Do not poll. Running MORE THAN ONE worker, set
     wake_when_idle(scope="project", body="...") ONCE and go quiet: it is a
     STANDING watch over the crew you spawn, it reports each worker as it
     finishes, it covers workers you spawn later, and you never re-arm it.
     wake_when_idle(agents=[...], body="...") is the one-shot: it fires on
     the first finish and STOPS WATCHING the rest, so at three or more
     workers it will lose one. Either way, read REAL output (agent_output)
     before declaring a lane done. The human can watch live with
     tmux attach -t hive-main.
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

  profiles: `PROFILES — standing instructions shared across projects

A profile is a named set of instructions this project runs under, named by
"profile:" in hive.yml. hive resolves each file from ~/.hive/profiles first,
then its own defaults, so a file the human forked is theirs and the rest
track hive.

  posture.md   already in your system prompt if the session started with
               hive lead, with this project's vars resolved. You do not need
               to read it; \`hive posture\` shows the human what you were given.
  runbook.md   the project's process. Read it with \`hive runbook\` (a shell
               command, not a tool). It has hive.yml vars substituted.
  worker.md    what agent_spawn puts in a worker's system prompt.

  hive runbook               the process, ready to read
  hive posture               the posture text you were started with
  hive profile list          what exists and where each file comes from
  hive profile fork <name>   copy a default into ~/.hive so the human can edit

A project with a profile usually has NO "runbook" pad; the profile replaced
it. A project on "profile: none" keeps the pad, and \`hive runbook\` prints
that instead, so the one command is right either way.

If the human asks to change how work runs here, that is an edit to the
runbook (fork it first), not a pad write.`,

  agents: `AGENTS — spawn and drive worker sessions in tmux

  agent_spawn(name?, model?, command?, extra_args?, cwd?, placement?, layout?) —
    start a worker (default command: claude) in session hive-main.
    placement="split" (default) tiles the worker as a pane in the lead's
    window so the whole crew shares one screen; placement="window" gives it
    its own tmux window (an iTerm tab under control mode). layout picks how split panes are
    arranged: tiled (default), main-vertical (lead takes the left half,
    workers stack on the right), main-horizontal, even-horizontal,
    even-vertical. hive re-applies it when a worker closes, so the
    arrangement survives crew changes. Projects can set a default placement
    and layout in hive.yml; an explicit argument overrides it. cwd defaults to the project root; pass
    a git worktree path to isolate parallel file edits. A claude worker gets
    its brief in the system prompt; other commands return instructions to
    PREPEND to the first prompt.
    Workers run with HIVE_PROJECT_LOCK=1.
  agent_send(name|agent_id, text?, keys?, submit?, wait_ms?) — type into the
    worker's terminal. Multi-line text pastes safely; keys sends tmux key
    names like Escape or C-c. wait_ms returns the terminal tail after.
  agent_output(name|agent_id, lines?) — read the rendered terminal.
  agent_status(name|agent_id, include_brief?) — liveness, current command,
    short tail, and the path to the brief this worker was given
    (include_brief=true returns its text; no transcript records it).
  agent_list(include_closed?) — all agents with live status.
  agent_rename(name|agent_id, new_name) — change the display name. actor_id
    stays agent:N, so older pad writes and todo comments still point here.
    A live claude worker is told to retitle its own session, which arrives as
    a user turn: rename between assignments, not mid-task.
  agent_park(name|agent_id) — END OF DAY. Kill the pane, mark the row PARKED
    rather than plain closed, record the branch, and hand back a board line
    plus the one call that brings the lane back. Use this instead of
    agent_close whenever the lane is PAUSED rather than finished: "closed"
    alone means both, and a next-morning lead cannot tell them apart.
  agent_resume(name|agent_id) — NEXT MORNING. Reopen a closed or parked
    claude worker on a fresh pane from its recorded session id, with the same
    actor_id and its full prior context. It does not send the assignment;
    agent_send it afterwards. Read the pane before believing any wake about
    a worker you just resumed.
  agent_close(name|agent_id) — kill the worker's pane and mark closed. Capture
    handoffs first; output is not retained. Self-close needs confirm_self.
    On a PARKED row (by agent_id) it releases the park instead, which is how
    you abandon a lane you have decided not to resume.

Address a worker by its name, not its id: agent_send(name="impl", ...). A
partial name works when it matches one running worker, so name="123" finds
DEVX-123. The name is the handle you chose and the one shown in its pane.

Visibility is automatic: if nothing is attached to the project session when
a worker spawns, hive pops open iTerm (control mode by default; see
hive setup --attach) or Terminal attached to it, so the human sees every
worker as a native window and can type into any of them. The human usually
starts the day with the CLI: hive lead.
Manual attach also works: tmux attach -t hive-main, or
tmux -CC attach -t hive-main for iTerm's native windows.

Worker state (agent_state on list/status) comes from Claude Code hooks that
agent_spawn wires automatically: working (prompt submitted), idle (finished
its turn), waiting (needs permission or input). Non-claude commands show
"unknown".`,

  wakes: `WAKE-UPS — scheduled nudges instead of polling

  wake_set(delay_seconds, body, deliver_to?, repeat_every_seconds?) —
    one-shot or repeating wake-up
  wake_when_idle(agents | scope, body, mode?, max_wait_seconds?,
    deliver_to?) — fire when workers go idle. Pass exactly one of:
      scope="project" — a STANDING watch over the crew you spawn in this project.
        It reports EACH worker as it finishes or its window dies, covers
        workers spawned after you set it, and keeps watching until
        max_wait_seconds (default 4 hours) or wake_cancel. Workers already
        idle DO count, deliberately. Use this whenever more than one worker
        is running. ONE PER PROJECT: setting a second is refused and names
        the one already running, so calling twice costs nothing.
      agents=[...] — a ONE-SHOT over a named list. mode=any (default) fires
        on the first fresh idle transition and then STOPS WATCHING the
        others; mode=all fires when every watched agent is idle and returns
        already_satisfied instead of scheduling if they already are.
        Agents already idle when it was set do not count.
  wake_get(wake_id) — read one wake-up by id, with its untruncated body
    (wake_list truncates at 120 chars)
  wake_update(wake_id, delay_seconds?, body?, repeat_every_seconds?) — edit
    a pending wake-up you own in place, without minting a new id.
    delay_seconds is relative to now; repeat_every_seconds changes only the
    interval used for firings after this one. Only body can be edited on an
    idle wake (from wake_when_idle); delay_seconds/repeat_every_seconds
    apply to a delay wake (from wake_set) only.
  wake_cancel(wake_id) — cancel a pending wake-up you own
  wake_list() — pending wake-ups in this project

Delivery contract:
  When a wake-up fires, its body is typed into the target session's terminal
  as a fresh user turn, prefixed with [hive wake #N]. The receiving agent
  gets it cold, so write bodies self-contained: agent ids, pad/todo ids,
  and the next action. Plain English, no markup.
  Waking your OWN lead pane is the exception: it is not cold, so carry the
  action and the ids and point at where the detail lives.

Receiving wake-ups:
  Spawned workers can always receive (deliver_to their name or id).
  A lead session can receive only if it runs inside tmux; start it with
  tmux, then claude (watch with tmux attach, or tmux -CC attach for iTerm's
  native windows). Otherwise wake_set without deliver_to fails with guidance.

Idle detection is exact, not heuristic: Claude Code hooks in each spawned
worker report working/idle/waiting into the shared store the moment they
happen. Cancel wake-ups when the monitored work is done.`,

  projects: `PROJECTS — scope management

Every pad, todo, kv entry, and lease belongs to one project (a directory).

  project_list — all registered projects plus the current selection
  project_add(path?, name?) — register a directory (defaults to cwd)
  project_select(project_id) — set this session's default scope
  project_prune() — delete every registered project that owns no rows
    anywhere in the store, verified individually; never your own; refuses
    under HIVE_PROJECT_LOCK=1 since it sweeps every project, not just yours

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

whoami shows your actor id, kind, and effective project.

See help(topic="actors") for actor_prune.`,

  actors: `ACTORS — pruning stale identities

  actor_prune() — delete every actor that owns no rows anywhere in the store
    and has not been active in the last minute, checked globally across
    every project since actors carry no project_id; never your own;
    refuses under HIVE_PROJECT_LOCK=1 since it sweeps the whole store

See help(topic="identity") for how an actor id is assigned in the first
place.`,

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

  todo_create(title, body?, priority?, tags?, slug?, blocked_by?) — priority
    is high|medium|low; slug is a short label (~3-5 words) so this todo
    reads the same way everywhere it's referenced by id
  todo_list(status?, is_blocked?, priority?, query?, tags?, include_archived?, limit?, offset?)
    — status is open|in_progress|backlog|completed; is_blocked=false finds
    dispatchable work; archived todos are excluded unless include_archived
  todo_get(todo_id, include_comments?) — full body, blockers, comments;
    always reaches an archived todo too, by id
  todo_update(todo_id, title?, body?, priority?, status?, tags?, slug?)
  todo_archive(todo_id, archived?) — retires a todo but keeps it readable
    by id; archived=false reverses it. Refuses if this todo still blocks
    a non-completed todo, unless this todo is itself completed
  todo_complete(todo_id, completed?) — returns newly_unblocked todo ids;
    completed=false reopens
  todo_comment(todo_id, body) — handoffs, decisions, findings
  todo_block(todo_id, blocker_id) / todo_unblock(todo_id, blocker_id)

Blockers form a dependency graph (cycles are rejected). A todo is blocked
while any of its blockers is not completed. Archived and completed are
independent axes: archiving hides a closed lane's scaffolding from
todo_list without marking anything done.`,

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
