Issue #82. hive exposes 42 MCP tools and 18 CLI commands with no stated
contract for what a resource is supposed to have. Read this before adding a
tool or a command, not after: a rule fires when you open a file it covers,
which is the moment a new tool gets its name.

**Unlike the project's other rules, almost nothing here is enforced by
code.** `.claude/rules/tool-contract.md` is a naming convention and a matrix, not a guard.
`test/docs.test.mjs` pins that `.claude/rules/tool-contract.md` exists, that its `paths` globs still match
a real file, that every path it cites is real, that it stays indexed in
`CLAUDE.md` and `src/AGENTS.md`, and that `CLAUDE.md`'s table names the exact
same globs its own frontmatter does - the same five checks every
rule file gets. None of that pins its CONTENT against the code: nothing
fails if the matrix drifts from what `src/tools/*.ts` actually registers, or
if the naming convention stops matching what a new tool was actually named.
Treat the matrix as verified at the time #82 wrote it, not as
self-maintaining.

Two claims in the unknown-key section below are the exception, and only two.
`test/wire-surface.test.mjs` pins that every object in the generated surface
advertises `additionalProperties: false`, and that a `pad_delete` carrying
the misspelled `expected_revison` is refused at runtime with a -32602 naming
the key. Those two fail a test when they stop being true. **Everything else
in that section is prose like the rest of this file** - the one-object-level
claim, the cost to a still-running server, the list of no-parameter tools,
the bypass paths. Verify before relying on any of them.

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
| todos | `todo_create` | `todo_get` | `todo_list` | `todo_update` | `todo_archive` | none, accepted (`src/tools/todos.ts`) |
| kv | `kv_set` | `kv_get` | `kv_list` | `kv_set` | TTL | `kv_delete` |
| leases | `lease_acquire` | none, accepted (`src/tools/leases.ts`) | none, accepted (`src/tools/leases.ts`) | `lease_acquire` (re-acquiring extends) | TTL | `lease_release` |
| agents | `agent_spawn` | `agent_status` | `agent_list` | `agent_rename` | `agent_park` | `agent_close` |
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

Two more tools landed since #82 that the table doesn't fully account for.
`agent_park` filled the agents row's Retire cell, above (issue #156, the
worked example in the naming section below). `agent_resume` did not get a
cell: it reverses a park rather than performing one of the six lifecycle
verbs, so it sits outside this table on the same grounds as
`todo_complete`/`todo_block`/`todo_unblock` do further down - a domain
operation on state the table has no column for, not a gap to fill in.

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
  one. **`agent_park` (issue #156) is the worked example of the override
  half**, and of a cell in the matrix above being filled rather than
  distrusted: parking a worker is soft (the row stays readable by id),
  reversible (`agent_resume`), and does more than flip a row (it kills a
  live pane), so it takes a domain verb for the same reason `agent_close`
  overrides Remove. The alternative considered and rejected was a `park`
  boolean on `agent_close`: a flag that changes what a verb means makes one
  description answer for two operations, and `agent_close`'s refusals carry
  reasoning about ending a lane that was never made about pausing one.
- **Remove**: hard, permanent. Default `<resource>_delete`. Override with a
  domain verb when removal does more than delete a row: `agent_close` kills
  a live process first, `lease_release` gives up a claim without deleting
  any history of it having existed. **Write tools return slim receipts**
  (see the section below), and a slim receipt cannot confirm what it does
  not echo, so prefer a dedicated read tool (`lease_get`, `wake_get`) over
  widening a write tool's response to compensate for one. Do not invert
  that argument into skipping the read tool because the write response
  could just be made fatter instead.

## Write tools return slim receipts

Every tool registered here answers a write with the minimum that identifies
what it did: the ids, and the one or two fields a caller cannot reconstruct.
Token cost is a design input, not an afterthought. These responses land in
the context of every session that calls them, and a lead makes hundreds of
such calls across a wave.

The consequence to hold onto is that **a slim receipt cannot confirm what it
does not echo.** When a field matters, read it back with the resource's own
read tool rather than assuming the write did what you asked. `todo_archive`
returning `{todo_id, archived}` says the row was archived; it says nothing
about whether the comments survived, and that is exactly the thing worth
checking after a retire operation.

This is the reason the Read-one column of the matrix above is not optional
decoration. A resource with no read tool forces the choice between a fatter
write response and an unverifiable one.

`todo_complete` and `todo_block`/`todo_unblock` are not lifecycle verbs and
sit outside this table on purpose: they are domain operations on a todo's
status and dependency graph, not create/read/update/retire/remove of the
todo row itself. A new domain operation like these does not need a slot in
the six verbs above; it needs its own clear name and a description that
says what state it touches.

## Every tool rejects an unknown argument key, and you get that for free

PR #125 found this. All 45 tools advertise
`additionalProperties: false` and refuse an undeclared key at runtime with a
-32602 that names it. Both halves come from `src/strictInput.ts`, which wraps
`registerTool` once on the single `McpServer` in `src/index.ts` and rebuilds
each raw shape as a `z.strictObject`. **No `src/tools/*.ts` call site
participates, so a new tool registered the way the others are is strict
without its author doing anything.** (Todo 462 gave this wrapper a third
job, building `structuredContent` for the tools that declare `outputSchema`
- see "A tool that declares outputSchema must always return a JSON object"
below.) `test/wire-surface.test.mjs` walks the
generated surface and requires `additionalProperties: false` on every object
in it, so a tool that escaped the wrapper fails there rather than depending
on anyone reading this paragraph.

**Three ways to write a tool that is NOT strict**, listed because this
section fires when you open `src/tools/*.ts` to write the 43rd one, which is
exactly when they apply:

- **Omit `inputSchema` entirely.** The SDK then skips `validateToolInput`
  altogether and the tool accepts anything. Verified by registering one and
  calling it with `{typo: true}`; the handler ran. hive's four no-parameter
  tools avoid this by declaring `inputSchema: {}`, an empty raw shape the SDK
  treats as a shape, which the wrapper rebuilds strict like any other. Caught
  by the wire test (the SDK advertises a bare `{type: "object"}` for it).
- **Declare a nested object parameter with `z.object`.** Strictness is one
  object level; the wrapper makes the root strict and cannot reach a shape's
  values. Use `z.strictObject` for the nested one. Caught by the wire test,
  which walks rather than reading the root.
- **Use `server.tool(...)` (deprecated) or `RegisteredTool.update({paramsSchema})`.**
  Both go around `registerTool`: `tool()` calls `_createRegisteredTool`
  directly, and `update()` rebuilds a LOOSE object through `objectFromShape`.
  hive calls neither. `tool()` is caught by the wire test; a runtime
  `update()` is caught by nothing, which is a reason not to reach for it.

`kv_set`'s `value` is `z.any()` on purpose and is NOT one of these - arbitrary
keys there sit inside a declared parameter rather than beside it, which is
what the tool is for. It emits `{}` with no `type`, so the wire walk never
tests it and needs no exemption list.

**A parameter may not be named `_def` or `_zod`.** The wrapper tells a raw
shape from a built schema by looking for those keys on the container, so a
shape carrying one is refused at registration. That is a naming constraint,
not a bug to work around: the failure is loud, at startup, with a message
naming the tool, and no parameter in this surface is plausibly named either.

The history, because the fix reads as a revert otherwise. Until zod 4, 38 of
the 42 advertised `additionalProperties: false` (the four without it were the
no-parameter tools: `actor_prune`, `project_list`, `project_prune`,
`whoami`), **and the runtime never enforced it** - zod strips unknown keys
silently by default, so the advertised guard had value only to a client that
validated arguments before sending, which Claude Code does not. Issue #105's
zod 4 bump stopped emitting the key and was accepted on that basis.
What made it worth answering rather than accepting is the shape underneath:
`pad_delete({pad_id: 7, expected_revison: 3})` - one letter wrong - reached
the handler as `{pad_id: 7}`, and `checkRevision` returns SILENTLY when the
expected revision is absent and not required, so the pad was permanently
deleted while the tool's description promised the caller was guarded. The
typo and a deliberate omission produced the identical call.

The practical consequence when you add a tool: **declare every parameter a
caller may pass**, because anything you leave out is now refused rather than
ignored. And adding an optional parameter is no longer backward compatible
against a RUNNING server: it used to be ignored by a session on older
`dist/`, and is now refused until that session restarts, because a session holds the
`dist/` it started with and rebuilding does not reach it. That cost
was weighed and accepted: bounded by one restart, and
loud rather than silent. A refusal is per call, not per session - the SDK
turns it into an `isError` tool result carrying the -32602, so the caller
reads which key was wrong and corrects it.

## A tool that declares outputSchema must always return a JSON object

Todo 462 added `outputSchema` to hive's 28 write tools. The MCP SDK requires
`structuredContent` on the result whenever a tool's registered config carries
`outputSchema` - confirmed by driving a minimal server built in complete
isolation from hive's own `dist/` (a bare `McpServer` with one tool, no hive
code at all): a handler that returns only text content, with `outputSchema`
declared and no `structuredContent` set, comes back `MCP error -32602:
Output validation error: Tool echo has an output schema but no structured
content was provided`. The SDK does NOT build `structuredContent` from the
handler's return value itself; it only validates whatever the handler
already attached.

The first attempt at this put the fix in `src/result.ts`'s `ok()`,
attaching `structuredContent` for every tool whose data is a plain object -
all 44, not just the 28 that declare `outputSchema`. That was found live,
not in review: a 29,880-character pad (the board's own size) round-tripped
through `pad_read` - which declares no `outputSchema` at all - at +100%
wire bytes, because the same object was now serialized twice, once as text
and once as `structuredContent`, with the second copy buying nothing for a
tool the SDK never validates. `pad_read` is the most-read tool call in this
project.

The fix moved to `src/strictInput.ts`'s wrapper instead, following the same
reasoning input strictness already rests on:
a rule enforced by sweeping the 28 declaring call sites is correct until
the 29th one is added by someone who doesn't know to repeat it; a rule
enforced at the one choke point every `registerTool` call already passes
through is enforced automatically. When a tool's config carries
`outputSchema`, its callback is
wrapped to parse `structuredContent` out of the already-computed text
content after the handler returns - every other tool's `ok()` output is
untouched.

That same wrapper adds an optional `hive_notice` string to every declared `outputSchema` and sets it on the first result after a rebuild or a project registration (todo 1409). Claude Code 2.1.282 shows the model only `structuredContent` for a tool with `outputSchema` and drops `content`, so a notice appended as a second text item was spent unseen; a tool that used the key itself would collide with it.

**The wrapper fails loudly, not silently, when a declaring tool's result
cannot be parsed as a JSON object** - a named, diagnosable `isError` result
instead of falling through to the SDK's own opaque "no structured content
was provided", which names no tool and no cause. Proven red-first:
`test/output-schema-guard.test.mjs` was run against the wrapper reverted to
its silent form first, confirmed to fail against the SDK's generic message,
then run again against the fix, confirmed green. 15 of the 28 declaring
tools were driven live and returned objects; the other 13 needed a live
tmux pane to reach - all five agent tools (`agent_spawn`, `agent_resume`,
`agent_park`, `agent_rename`, `agent_close`) and `wake_when_idle`'s
standing-watch and one-shot branches were driven live too, using a private
`TMUX_TMPDIR` + scratch `HIVE_DATA_DIR` and a `claude`-named shim binary
that just execs `cat` (`isClaudeCommand` only checks the basename). The one
branch not reached live is `wake_when_idle`'s `already_satisfied`
short-circuit, which needs real Claude-Code-hook-driven idle state -
accepted as a named gap rather than claimed away; it is a two-key object
literal built directly in source with no computed or string-typed
intermediate.

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
launched. That was measured exactly, trying to make `HIVE_ATTACH_MODE` an env
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
free because the first half shipped. No CLI command reaches leases or wakes
today, and no MCP tool reaches backups, restore, profiles, posture, runbook,
or doctor; both are the split working as intended, not omissions to close.

**Narrowed since, for kv specifically.** `cmdAttach`/`cmdLead`'s
`maybeOpenDashboard` (`src/cli.ts`) reads and writes one kv row directly, via
the same process's `db` handle rather than through `kv_set`/`kv_get`. This is
not the gap the mechanical reasoning above warns about: that reasoning is
about a value set in ONE process (a shell env var, a CLI flag) failing to
reach a DIFFERENT process (the MCP server), and there is no process boundary
here at all - the CLI and every `kv_*` tool already share one `db` handle
onto the same sqlite file in the same process. Still narrow: this is one CLI
command touching one table for one purpose, not a general precedent for CLI
code to bypass MCP tools where a real process boundary would apply.
