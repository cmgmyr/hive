---
paths:
  - "src/tools/*.ts"
  - "src/cli.ts"
  - "src/help.ts"
  - "src/context.ts"
  - "src/strictInput.ts"
---

# The tool contract: lifecycle, naming, and the CLI/MCP split

**Renaming any existing tool or command is out of scope, permanently.**
This file binds what gets ADDED. A
name in the lifecycle matrix that reads as a mistake is a mistake to live with, not to fix.

## Write tools return slim receipts

The consequence to hold onto is that **a slim receipt cannot confirm what it
does not echo.** When a field matters, read it back with the resource's own
read tool rather than assuming the write did what you asked.

## Every tool rejects an unknown argument key, and you get that for free

**Three ways to write a tool that is NOT strict**:

- **Omit `inputSchema` entirely.**
- **Declare a nested object parameter with `z.object`.** Use `z.strictObject` for the nested one.
- **Use `server.tool(...)` (deprecated) or `RegisteredTool.update({paramsSchema})`.**
  hive calls neither.

`kv_set`'s `value` is `z.any()` on purpose and is NOT one of these.

**A parameter may not be named `_def` or `_zod`.** That is a naming constraint,
not a bug to work around.

The practical consequence when you add a tool: **declare every parameter a
caller may pass**, because anything you leave out is now refused rather than
ignored. And adding an optional parameter is no longer backward compatible
against a RUNNING server: it used to be ignored by a session on older
`dist/`, and is now refused until that session restarts. A session holds the
`dist/` it started with, so rebuilding does not reach it.

## A tool that declares outputSchema must always return a JSON object

Never a bare string or anything else - every call to that tool fails
otherwise, not just an odd one. `src/strictInput.ts`'s wrapper fails loudly
and by name when this happens, not silently. That wrapper also declares an optional `hive_notice` on every outputSchema; a tool must not
use that key, because the restart and registration notices ride there.

## The CLI and MCP split

- **MCP tools are how a Claude Code session (lead or worker) reads and
  writes shared STATE that the store owns.**
- **CLI commands are how a HUMAN at a real terminal (or a script standing
  in for one) operates the ENVIRONMENT hive runs in.**

Anything
an MCP tool needs to read has to be stored config (`hive.yml`, the
database) or an argument the caller passes on every call, never an
environment variable set in front of a different process.

New capability rule: decide which side is being asked for FIRST. A capability
genuinely needed on both sides
gets built for whichever is asked for first, and the other side is a
separate, deliberate addition with its own review, never assumed to come
free because the first half shipped. No CLI command reaches leases or wakes
today, and no MCP tool reaches backups, restore, profiles, posture, runbook,
or doctor; both are the split working as intended, not omissions to close.

**Narrowed since, for kv specifically: `cmdAttach`/`cmdLead`'s `maybeOpenDashboard` (`src/cli.ts`) reads and writes one kv row directly, via the same process's `db` handle rather than through `kv_set`/`kv_get`.** Still narrow: this is one CLI
command touching one table for one purpose, not a general precedent for CLI
code to bypass MCP tools where a real process boundary would apply.

See `.claude/skills/hive-internals` for the lifecycle matrix, the naming convention for new tools, and the incident history behind these.
