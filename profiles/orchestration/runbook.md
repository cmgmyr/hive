RUNBOOK — how work runs here. Read this when the human opens the day or asks
you to orchestrate. Live state belongs in the "board" pad, not here.

This is hive's skeleton, not your process. Fork it and fill it in:

    hive profile fork orchestration runbook.md
    $EDITOR ~/.hive/profiles/orchestration/runbook.md

Angle brackets are yours to replace. Doubled-brace placeholders are filled
from `vars:` in the project's hive.yml. A section can also be made
conditional on a var, so one runbook serves a repo with a tracker and one
without: the section simply is not here when its var is unset. Open the
unrendered file for the syntax: `hive profile path <name> runbook.md`.

THE ONE RULE
<the invariant that always holds here>

LANES
<the kinds of work and how each runs: who does it, on what branch, what
counts as done>

<!--if:ticket_prefix-->
TICKET LANE ({{ticket_prefix}}-NNN)
<how a ticket becomes a branch, a worker, and a finished change>
<!--if:start_command-->
Start ticket work with: {{start_command}}
<!--end-->
<!--end-->

WORKTREES
<where they live and when they get removed>
Facts that hold in any hive project:
- A git worktree resolves to the primary checkout's project, so every
  worktree shares one store. Ids in a pad mean the same thing everywhere.
- Parallel file edits need one worktree per worker, passed as agent_spawn's
  cwd. Two workers in one checkout will fight.
<!--if:install-->
- A fresh worktree has no dependencies installed: {{install}}
<!--end-->

MORNING TRIAGE
1. Read the "board" pad, then todo_list(status="open") for the queue.
2. <project checks: PR queue, ticket tracker, CI>
3. Agree the day's lanes with the human, then dispatch per
   help(topic="workflow").

COLD BOOT (after a crash, a reboot, or a closed terminal)
- `hive status` for what the store still thinks is running, then `hive doctor`
  to sweep rows whose panes are gone.
- A dead pane keeps nothing. Terminal output is not retained, so a worker's
  results exist only where it wrote them: todo comments, pads, commits.
- Re-read the board pad before re-dispatching anything. Assume nothing about
  what the previous session was mid-way through.

STANDING RULES
- Do not poll workers. wake_when_idle(agents=[...]) and go quiet.
- Read real diffs and agent_output before calling a lane done.
- Capture handoffs in todo comments or pads BEFORE agent_close.
- Anything outward-facing waits for explicit human approval.
<!--if:repo-->
- This project's remote is {{repo}}.
<!--end-->
