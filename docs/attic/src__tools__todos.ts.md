# Attic: src/tools/todos.ts

Comments removed from `src/tools/todos.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 30

```
// Full rationale (free text vs kebab-case, the character bound,
// why a fallback rather than a backfill) is in the migration's own comment
// in src/db.ts; not repeated at each site below.
//
// No .min(1): the codebase's own precedent for "clear a
// text field back to its default" is passing "" (this file's own `body` has
// no min(1) either), and slug had no way to do that at all - COALESCE(?,
// slug) plus a min(1) meant no value could ever reset the column. "" now
// round-trips: on todo_update it clears the stored slug back to the
// computed fallback (see summarize() below); on todo_create it is
// equivalent to omitting the argument.
```

## line 46

```
// Same detector and no-exceptions policy as normalizeAgentName
// (src/tools/agents.ts): a slug is a short label, not prose, and it
// reaches a pane through a wake body the same way a name does.
```

## line 56

```
// fallbackSlug and SLUG_MAX_LEN live in src/slug.ts now -
// re-exported here so nothing that imports them from this file breaks.
```

## line 60

```
// Shared with the CLI (hive todos --status): one list of valid statuses, so
// a status the MCP schema would reject can't slip past the CLI's own check
// and read as "you have no todos" instead of "that isn't a status".
```

## line 66

```
// What "blocked" means, in one place. Correlates on t.id, so every caller
// spells its own status filter and reads dispatchability the same way:
// todo_list(is_blocked=false), hive statusline, and the kickoff digest all
// have to agree or the lead is reconciling numbers hive disagrees with itself
// about. Same shape as ACTIVE_TIMER_WHERE in scheduler.ts.
```

## line 74

```
// The mirror of OPEN_BLOCKERS_SQL, addressed from the blocker's own id
// (a `?` parameter) rather than a correlated t.id: todos that currently
// depend on ? and are not yet completed. todo_complete's newly-unblocked
// check and todo_archive's refusal both need exactly this join; extracted
// so the two cannot drift on what "still depends on this one" means.
//
// archived_at IS NULL (#15): an archived dependent
// is not something anyone is waiting on - it is already invisible from
// every default list, same as the blocker it would otherwise strand.
// Without this, archiving a blocked dependent first and then its blocker
// second was refused forever, with no way out but falsely completing the
// dependent or destroying the edge.
```

## line 89

```
// Shared with the CLI (hive doctor's review-findings check): the
// same "does this todo have a comment" subquery SUMMARY_SQL embeds below, so
// the two cannot drift on what counts as commented-on.
```

## line 109

```
// Shared with the CLI: the list-row shape both `hive todos` and `hive todo
// <id>` build on.
```

## line 129

```
// '' means no slug was set (this table's DEFAULT) or was explicitly
// cleared back to it; fall back to a truncation of the title. That can
// itself read '' for a title that is all whitespace/control characters
// (fallbackSlug strips both before checking), so the last resort names
// the row by id - a synthetic label, never blank, and always well under
// SLUG_MAX_LEN so it round-trips through todo_update like any other slug.
```

## line 158

```
// Shared with the CLI (hive todos): the same status/priority/query/tag/blocked
// filtering todo_list uses, so the two surfaces cannot disagree about what
// "dispatchable" or "matches" means. `statuses` is a set, not todo_list's
// single `status` param: the CLI's default view is "open or in_progress"
// together, which an exact-match `status` cannot express, so the MCP handler
// below passes a one-element array to stay behaviour-identical.
```

## line 181

```
// slug is the field's whole purpose - a lead who knows a todo as "pane
// steal" and searches that gets zero results without it, since that
// string may appear nowhere in title or body at all.
```

## line 224

```
// Shared with the CLI (hive todo <id>): full detail, comments included when
// asked. Throws when the id is unknown in this project; the CLI catches that
// to print its own usage line rather than a stack trace.
```

## line 275

```
// #15 (found by the CI gate): the archived-blocker check
// and the INSERT were two separate statements, so a concurrent todo_archive
// could land in the gap - archiving the blocker AFTER this check passed and
// BEFORE the edge was written, recreating the exact invisible-active-blocker
// bug this check exists to prevent. Same .immediate() treatment as
// archiveTodo below, for the identical reason: the write lock has to be held
// from BEGIN, before the archived_at read runs.
```

## line 305

```
// #15: the blocker check and the UPDATE were two
// separate statements, so another session's todo_block/todo_create could
// insert a live blocker edge in the gap between them - the same shape #97's
// CI gate caught in src/tools/meta.ts, whose own comment has the fuller
// argument for .immediate() over a plain (deferred) transaction: a deferred
// transaction only takes the write lock at its first write, so the read
// below would still run unlocked and the race would just move one line
// later. IMMEDIATE takes the write lock at BEGIN, before getTodo's read
// runs, so no other writer can commit a new blocker into this project
// between the check and the write.
```

## line 320

```
// Archiving is refused, not silently allowed, when this todo still
// blocks live work: a dependent's blocker would go invisible from
// todo_list's default view while still active. Two separate
// conditions, both from the pad's own wording:
//   - the dependent (t below) is not completed - the same status
//     check OPEN_BLOCKERS_SQL uses to decide whether a blocker
//     counts at all.
//   - THIS todo is not completed. That is not implied by the
//     dependents query, which reads the dependent's status, not
//     this one's - conflating the two was a bug caught by a smoke
//     test before this landed. When this todo IS completed,
//     OPEN_BLOCKERS_SQL already excludes it from every dependent's
//     open_blockers (verified for #15), so archiving it changes
//     nothing and must be allowed unconditionally.
```

## line 351

```
// #15 (found by the CI gate): the un-completing guard
// below read todo.archived_at/status through an earlier getTodo and wrote
// later, with nothing between - the same gap as addBlocker above, reached
// through todo_update instead. A concurrent todo_archive could archive this
// todo (unconditionally allowed once it is completed and has no open
// dependents) after the guard's read and before its own UPDATE, letting a
// reactivating status change land on a todo that is now archived. Wrapped
// with the same .immediate() treatment.
```

## line 373

```
// Moving TO completed, or changing status on a todo that was never
// completed, carries no reactivation hazard and is left alone.
```

## line 409

```
// Same gap as updateTodo above, reached through todo_complete's reopen path
// instead: the reactivation guard read archived_at through an earlier
// getTodo and wrote later, with a concurrent todo_archive able to land
// between. Same .immediate() treatment; also folds in the newly-unblocked
// query so that read is consistent with the write that produced it, not
// just the reactivation guard.
```

## line 443

```
// No todo_delete (issue #82, and #15 before it). A todo's comments are the
// only durable record of a worker's reasoning once its pane is gone, and
// this project has already leaned on that record more than once. pad_delete
// exists because a pad can be genuinely disposable; a todo carrying a
// worker's handoff is not. #15 asks for todo_archive instead, to hide a
// closed lane's scaffolding without destroying it.
```
