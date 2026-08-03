---
paths:
  - "src/tools/*.ts"
  - "src/cli.ts"
  - "src/help.ts"
  - "src/context.ts"
---

# The tool contract: lifecycle, naming, and the CLI/MCP split

Issue #82. hive exposes 37 MCP tools and 18 CLI commands with no stated
contract for what a resource is supposed to have. Read this before adding a
tool or a command, not after: a rule fires when you open a file it covers,
which is the moment a new tool gets its name.

**Unlike the project's other rules, nothing here is enforced by code.**
This file is a naming convention and a matrix, not a guard. `docs.test.mjs`
pins that it exists, that its `paths` globs still match a real file, that
every path it cites is real, and that it stays indexed in `CLAUDE.md` and
`src/AGENTS.md`, the same four checks every rule file gets. None of that
pins its CONTENT against the code: nothing fails if the matrix drifts from
what `src/tools/*.ts` actually registers, or if the naming convention stops
matching what a new tool was actually named. Treat the matrix as verified
at the time #82 wrote it, not as self-maintaining.

**Renaming any existing tool or command is out of scope, permanently.**
Pads, runbooks, profile docs, the board, and merged PR bodies all name tools
in prose that hive has no way to migrate. This file binds what gets ADDED. A
name below that reads as a mistake is a mistake to live with, not to fix.

## The verified lifecycle matrix

Checked against the code, not inferred from the tool list, as part of #82.
Cells marked accepted have one sentence of reasoning next to the code that
would have held the missing tool; see the file named in each case.

| Resource | Create | Read one | List | Update | Retire | Remove |
|---|---|---|---|---|---|---|
| pads | `pad_write` | `pad_read` | `pad_list` | `pad_edit`, `pad_append` | `pad_archive` | `pad_delete` |
| todos | `todo_create` | `todo_get` | `todo_list` | `todo_update` | none, filed as #15 | none, accepted (`src/tools/todos.ts`) |
| kv | `kv_set` | `kv_get` | `kv_list` | `kv_set` | TTL | `kv_delete` |
| leases | `lease_acquire` | none, accepted (`src/tools/leases.ts`) | none, accepted (`src/tools/leases.ts`) | `lease_acquire` (re-acquiring extends) | TTL | `lease_release` |
| agents | `agent_spawn` | `agent_status` | `agent_list` | `agent_rename` | n/a, folded into `agent_close` | `agent_close` |
| wakes | `wake_set`, `wake_when_idle` | `wake_get` | `wake_list` | `wake_update` | n/a | `wake_cancel` |
| projects | `project_add` | none, accepted (`src/tools/meta.ts`) | `project_list` | none, accepted (`src/tools/meta.ts`) | none, accepted (`src/tools/meta.ts`) | `project_prune` |
| actors | implicit (`src/context.ts`) | none, accepted (`src/context.ts`) | none, accepted (`src/context.ts`) | n/a | none, accepted (`src/context.ts`) | `actor_prune` |

Filed in the same batch from the #82 audit: #96 (wake read-plus-reschedule)
and #97 (the projects and actors remove cells, filed as one issue since the
manual sweep already treats them as one operation done twice). Both have now
landed: #97 as `project_prune` and `actor_prune`, #96 as `wake_get` and
`wake_update`, above. A future reader who finds a cell out of date because a
new gap got filed should update that cell, not distrust the rest of the
table.

## Naming a new tool

Six lifecycle verbs recur across the resources above, and they already
disagree with each other in ways that are partly domain and partly drift.
This section is the rule for the next tool, not a relitigation of the
current names.

- **Create**: default `<resource>_create`. Override with a domain verb only
  when the operation does something categorically past "insert a row", the
  way `agent_spawn` starts a process and `lease_acquire` contends for one.
  Name the override for what it does, not to match a neighboring resource.
- **Read one**: default `<resource>_get`, addressed by id.
- **List**: default `<resource>_list`.
- **Update**: default `<resource>_update`, editing any subset of fields. A
  tool that can only ever change ONE field may use a narrower name instead
  (`agent_rename`), when the narrower name is clearer than a generic update
  would be with everything else held constant.
- **Retire**: soft, reversible, still readable by id afterward. Default
  `<resource>_archive`, matching `pad_archive`. Do not build this for a
  resource whose retirement is really removal with a safety check first
  (see the projects/actors gap above); that is the Remove verb, not this
  one.
- **Remove**: hard, permanent. Default `<resource>_delete`. Override with a
  domain verb when removal does more than delete a row: `agent_close` kills
  a live process first, `lease_release` gives up a claim without deleting
  any history of it having existed. **Write tools return slim receipts**
  (CLAUDE.md's own invariant), and a slim receipt cannot confirm what it
  does not echo, so prefer a dedicated read tool (`lease_get`, `wake_get`)
  over widening a write tool's response to compensate for one. Do not
  invert that argument into skipping the read tool because the write
  response could just be made fatter instead.

`todo_complete` and `todo_block`/`todo_unblock` are not lifecycle verbs and
sit outside this table on purpose: they are domain operations on a todo's
status and dependency graph, not create/read/update/retire/remove of the
todo row itself. A new domain operation like these does not need a slot in
the six verbs above; it needs its own clear name and a description that
says what state it touches.

## The CLI and MCP split

Unstated until now, so every new capability re-decided it. The pattern that
already holds, stated as a rule:

- **MCP tools are how a Claude Code session (lead or worker) reads and
  writes shared STATE that the store owns**: pads, todos, kv, leases,
  agents, wakes, and project/actor rows. A session calls these mid-turn,
  gets a slim JSON receipt back, and keeps working.
- **CLI commands are how a HUMAN at a real terminal (or a script standing
  in for one) operates the ENVIRONMENT hive runs in**: starting and
  attaching to sessions (`lead`, `attach`, `start`), local file surfaces
  (`backups`, `restore`, `profile`, `posture`, `runbook`), diagnostics
  (`doctor`, `status`, `statusline`), and initial setup (`init`, `setup`).

The reason the split holds is mechanical, not stylistic: an MCP tool runs
inside the MCP server process, which Claude Code starts from its own
registration, and a value set in a shell the human is typing into does not
reach that process by any path except accident of how the session was
launched. `.claude/sessions/dead-ends/2026-08-02-env-var-for-mcp-server-
config.md` measured exactly this trying to make `HIVE_ATTACH_MODE` an env
var an MCP tool could read: the CLI half honored it, the MCP half silently
did not, and it looked like it worked right up until it did not. Anything
an MCP tool needs to read has to be stored config (`hive.yml`, the
database) or an argument the caller passes on every call, never an
environment variable set in front of a different process.

New capability rule: decide which side is being asked for FIRST. If it is a
Claude Code session mid-task reading or writing shared state, it is an MCP
tool. If it is a human standing up or tearing down the environment hive
runs in, it is a CLI command. A capability genuinely needed on both sides
gets built for whichever is asked for first, and the other side is a
separate, deliberate addition with its own review, never assumed to come
free because the first half shipped. No CLI command reaches kv, leases, or
wakes today, and no MCP tool reaches backups, restore, profiles, posture,
runbook, or doctor; both are the split working as intended, not omissions
to close.
