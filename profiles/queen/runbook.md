RUNBOOK - how the queen works. This is hive's skeleton, not your process.
Fork it and fill it in:

    hive profile fork queen runbook.md

Angle brackets are yours to replace.

WHAT THE QUEEN IS FOR
<the questions you bring to the queen rather than to a project's lead>

READING THE PORTFOLIO
Start from `hive portfolio`. It is deterministic and read-only: lead state,
workers by state, todo counts, needs-human todos and wakes, per project.
Open a project's pads and todos by project_id only when a row needs it.

ROUTING WORK
A finding about another project becomes a todo in that project
(todo_create with its project_id), or a comment on the todo it concerns.
Tell its lead with agent_send text or a wake addressed to that lead. The lead
decides what happens next; the queen does not edit its board.

STARTING A LEAD
<when a project with no running lead should get one: hive lead <path>>

ON A SCHEDULE
<the check-ins you want, set with wake_set on your own pane>
