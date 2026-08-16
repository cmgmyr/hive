# Attic: test/todo-cli.test.mjs

Comments removed from `test/todo-cli.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
```

## line 10

```
// Issue #16: hive todos / hive todo <id>. Data is seeded through the real MCP
// tools (todo_create/todo_update/todo_block/todo_comment), not raw SQL,
// so these tests exercise the actual write path the CLI's shared helpers
// (listTodoSummaries, getTodoDetail) then read back.
```

## line 32

```
// Two distinct actors on the same todo (D4), one comment long enough
// that truncation at any fixed width would be visible (D6).
```

## line 41

```
// F1: every fixture above tops out at four todos, far short of
// listTodoSummaries' default limit of 50, so no test built on `seed()` can
// ever reach the truncation path. A fixture has to exceed the limit on
// purpose to test that a bound is reported rather than silently applied.
```

## line 76

```
// The negative is the assertion that actually pins filtering: a command
// that printed every todo regardless of status would still match the two
// greps above.
```

## line 95

```
// #15: hive pads has no flag to surface an archived pad at all
// (listActivePads is hardcoded to archived = 0) - hive todos follows the
// same precedent. --all widens which STATUSES are shown; it does not
// reach into archived_at, which stays MCP-only (todo_list's
// include_archived), same as pad_list's own parameter.
```

## line 113

```
// Counselors round on #15: "Blocked todo" alone as a positive control
// would still pass if --all dropped every unblocked, active todo (a
// much bigger bug than this test claims to guard). "Blocker todo" is
// unblocked and was never archived, and "Completed todo" is only
// visible under --all at all - both must still show.
```

## line 166

```
// No prior command has run here, so no project has ever been registered;
// resolveProject() would silently create one, which is exactly the
// behaviour D5 says to avoid.
```

## line 181

```
// 50 is listTodoSummaries' own default limit, hard-coded here on
// purpose: today's real behaviour is worth pinning, and a change to that
// default should make this test fail loudly rather than quietly track it.
```

## line 197

```
// The exact failure this test guards against: a broken implementation
// that just filters on an unrecognized value would print this instead.
```

## line 211

```
// F3: the same missing-value bug as --status, one flag over. Unlike
// --status, an unrecognized --tag value is never an error (any string is a
// legitimate tag, and "nothing carries it" is a real empty result), so only
// the missing-value case needs a guard here.
```

## line 226

```
// registers the project
```

## line 233

```
// F4: the runbook's own convention (step 13) tags every lane's todos
// issue-<N> so a FINISHED lane is easy to retrieve, and a finished lane is
// by definition all-completed. So the default open/in_progress filter
// hides exactly the todos that convention exists to make findable, and the
// empty message has to say what it filtered on, not just name the project,
// or "no todos" reads as false for a lane that is very much still there.
```

## line 251

```
// The default view hides it: this is the exact false-negative the runbook's
// tagging convention would hit on every completed lane.
```

## line 257

```
// --all proves the todo genuinely exists and filtering itself is correct;
// only the empty-view message was wrong.
```

## line 272

```
// Caught by the automated review on commit 2ee8452: the empty message's
// statusDesc checked `status` before `all`, so `--status --all` together
// described a narrower filter ("completed") than the one that actually ran
// (--all wins, so every status was searched). The real query already got
// this precedence right; only the message computed it backwards.
```

## line 279

```
// registers the project, no todos
```

## line 285

```
// Must NOT narrate "completed" only: --all means every status was
// actually searched, so the message must not name one narrower than that.
// IMMUNE to generated data, but not "plainly": the message DOES carry a
// generated value (project.name, basename() of scratchDirs()'
// mkdtemp-random projectDir - e.g. "project-wBTbTT"). It cannot produce
// this match only because of WHERE it lands: cmdTodos always writes
// `No ${statusDesc}todos in project "${project.name}"...`, and this
// whole test's premise is statusDesc === "" when --all wins, so the
// random name sits after the fixed "todos in project \"" delimiter and
// can never fuse with "No " to spell "No completed todos". A future
// caller that moved the project name BEFORE statusDesc, or dropped the
// delimiter between them, would inherit this exact bug.
```

## line 315

```
// D4: a reader must be able to tell the lead's notes from a worker's.
```

## line 318

```
// D6: the whole point of this command is that comments are not cut off.
// A test only checking that the comment appears at all would pass for a
// command that truncates at, say, 200 chars; assert the full length.
```

## line 331

```
// #15: todo_get (and cmdTodo, its CLI wrapper) always reaches an archived
// todo by id - that is the whole reason this is archive and not delete.
```

## line 351

```
// Counselors round on #15, P2: MCP todo_get exposes the archived axis;
// the CLI was silently dropping it, so an archived open todo rendered
// identically to an active one.
```

## line 356

```
// Positive control: an ordinary, un-archived todo must not print the
// marker at all - a status line that always says "archived" would
// still pass the assertion above.
```
