# Concepts

The vocabulary, identity model, workflow, and shared store behind hive.

## Vocabulary

| Term | Meaning |
|---|---|
| lead | The session you talk to. Plans, spawns workers, dispatches todos. `hive` starts one. |
| worker | A Claude session the lead spawns into a tmux pane, locked to the project. |
| actor | Who a write is attributed to: `user:<name>` for humans, `agent:<id>` for workers. |
| pad | A named shared document in the store. |
| runbook | The pad holding your standing instructions for a project's lead. |
| board | The pad holding today's live state; archived and rewritten each day. |
| lane | One independent stream of work: typically one worker plus one or more todos. |

## Identity

Every write records who made it. Set identity through environment variables when starting a worker session:

```bash
HIVE_AGENT_ID=worker-1 HIVE_AGENT_NAME="API worker" claude
```

Without `HIVE_AGENT_ID`, you are `user:<username>`. Ask `whoami` inside a session to check.

## The workflow

Ask any session for `help(topic="workflow")`. Short version: the lead interviews you, writes the plan to a pad, splits it into todos with blockers, and workers pull unblocked todos, comment their handoffs, and complete them. Completing a todo reports which todos it unblocked.

## Project scope

State is scoped to a project (a directory). The scope resolves in this order: an explicit `project_id` argument, the session's `project_select` choice, then auto-detection from the working directory. A working directory that matches no registered project becomes a new project automatically; sessions never silently attach to an unrelated one. Use `project_select` or `project_id` to reach another project's state on purpose.

Git worktrees and subdirectories resolve to the primary checkout's project, so a worker in a worktree shares the main repo's pads and todos. To treat a worktree as its own project instead, register its path explicitly with `project_add`.

## The shared store

Four primitives hold all coordination state. Each is project-scoped, lives in SQLite, and is visible to every session the moment it changes. Sessions die; the store lives.

**Pads** are named shared documents: the plan, research findings, the runbook, the daily board. A pad is the right home for anything a future session should be able to read without you re-explaining it. Every read returns a `revision`, and overwrites require `expected_revision`, so two sessions can never silently clobber each other; the loser gets a conflict and re-reads. Prefer `pad_append` and `pad_edit` for small changes so revisions stay cheap. Names are unique per project, and archiving retires a pad while keeping it readable by id, which gives you clean day-to-day rotation of pads like the board.

**Todos** are the work queue. Each one carries a body (objective, owned files, acceptance criteria), a priority, tags, and a comment thread. Blockers link todos into a dependency graph: blocked work stays out of the dispatch filter until its blockers complete, cycles are rejected outright, and completing a todo reports exactly which todos it freed. Comments double as the handoff trail between workers and sessions: changed files, tests run, decisions made, remaining risk.

**KV** is a small shared JSON scratch space for values other sessions should discover on their own: a dev server port, a feature flag, a shared setting. Values can carry a TTL and expire without cleanup.

**Leases** are soft claims on shared work areas, keyed by convention (`file:src/api/routes.ts`). A lease does not lock anything; it tells other sessions "someone is working here, pick a different lane." Leases expire on their own TTL, so a crashed worker never wedges the team, and re-acquiring your own lease extends it, which doubles as a heartbeat for long work.
