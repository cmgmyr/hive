# Attic: test/prune.test.mjs

Comments removed from `test/prune.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// The MCP server's scheduler can reach tmux even when a test never calls an
// agent_* tool; isolate first, same as every other file that starts a real
// server (test/CLAUDE.md).
```

## line 12

```
// This file's whole point is DELETE statements against project and actor
// rows, so it proves the store is scratch before opening it directly, same
// as test/backup.test.mjs and test/store-isolation.test.mjs.
```

## line 19

```
// Imported from the built tool file, not copied here, so a table or column
// added to either list picks up test coverage automatically instead of
// silently going unchecked - counselors round on PR #100, finding 5.
```

## line 24

```
// actor_prune's liveness guard (src/tools/meta.ts) holds back any actor
// touched within ACTOR_LIVENESS_WINDOW_MS (2 * TOUCH_INTERVAL_MS, 60s) of
// the prune call. Every actor row defaults last_seen_at to "now" at INSERT
// time (src/db.ts), so a survivor seeded to prove the OWNERSHIP check works
// must be backdated well past that window - otherwise it would survive
// because it looks freshly active, not because of the row proving ownership,
// and a mutation that broke the ownership check would go uncaught. Comfortably
// past 60s; not tied to the exact constant since this only needs to clear it.
```

## line 41

```
// One insert per PROJECT_OWNER_TABLES entry, each satisfying only that
// table's NOT NULL columns. A table added to the list with no case here
// throws loudly at test time rather than silently shipping unchecked -
// seeding needs domain knowledge (which columns are safe placeholders) that
// can't be derived generically from the schema.
```

## line 80

```
// Same idea as seedProjectOwnerRow, one insert per ACTOR_OWNER_COLUMNS pair.
```

## line 84

```
// name must be unique per (project_id, name) among running agents
// (idx_agents_running_name); actorId is already unique per case here.
```

## line 145

```
// Both prune tools sweep every registered project or actor in the store,
// not just this file's fixtures - whoami alone writes no owned row, so
// without this the primary project would itself look empty and get swept
// by the very first prune call below, taking every other test in this
// file down with it.
```

## line 174

```
// In a finally, not after the assertions: a failed assertion must not
// skip this and leak the child process. McpClient's stdout listener
// keeps this file's event loop alive until the process exits, so a
// leaked client hangs the whole suite instead of just failing one
// test - found the hard way while mutation-testing this file.
```

## line 183

```
// Mutation-tested and found NECESSARY, not decorative: the table-driven
// test below iterates PROJECT_OWNER_TABLES itself, so removing an entry
// from the list shrinks the test's own coverage right along with the
// check's - the iteration alone gave zero discriminating power against
// exactly the mutation that matters most (an edited list). This pins the
// list's actual contents independently, so dropping or renaming an entry
// reddens HERE even though the table-driven test would stay silent.
```

## line 197

```
// The whole point of finding 5 (PR #100 counselors round): the old version
// of this test protected exactly one table (kv), so it passed with six of
// seven PROJECT_OWNER_TABLES entries deleted from the list. This seeds one
// survivor per table, iterating the real exported list. Discriminates a
// broken CHECK (existsWhere, the .some() call) even though it cannot, on
// its own, discriminate an edited LIST - the assertion above covers that.
```

## line 243

```
// Counselors round on PR #100, finding 4: a per-row transaction can still
// throw, and the fix must not let that erase the receipt entirely. This
// forces a REAL failure with a genuine competing write lock from a second
// connection (no test-only hook in production code), in its own scratch
// store so no other candidate from earlier tests shares the wait.
```

## line 279

```
// Outer try/finally, same reasoning as the other McpClient tests in
// this file: a failed assertion above must still close lockMcp, or
// its leaked stdout listener hangs the whole suite rather than just
// failing this one test.
```

## line 326

```
// Counselors round on PR #100, finding 1 (P1): ownership is not the whole
// liveness question. A manually-identified session that has called a tool
// but not yet written anything owned must be held back, not treated as
// inert, and reported separately from the caller's-own-actor case.
```

## line 337

```
// creates the actor row; last_seen_at = now; owns nothing
// Closed here, before any assertion: an assertion that throws must not
// skip this and leak the child - McpClient's stdout listener keeps this
// file's event loop alive until the process exits, so a leaked one hangs
// the whole suite instead of just failing the one test. Closing the
// process does not touch the actor ROW the prune call below reads.
```

## line 355

```
// The realistic version, via real McpClient sessions and real tool calls
// rather than raw inserts, matching the issue's own motivating example
// (five real actors kept for real todo_comments they wrote). Both actors
// are backdated past the liveness window so this proves the OWNERSHIP
// check keeps the commenter, not the new liveness guard - todo_comments
// .author has no foreign key, so it is the one column a miss silently
// orphans.
```

## line 399

```
// Same reasoning as PROJECT_OWNER_TABLES's own pin above: the table-driven
// test below iterates this list itself, so it cannot catch a REMOVED
// entry on its own (both the check and the test's coverage would shrink
// together) - mutation-tested and confirmed. This pins the contents
// independently.
```

## line 422

```
// The exhaustive version of the above, covering every ACTOR_OWNER_COLUMNS
// entry, not just todo_comments.author - counselors round on PR #100,
// finding 5. The old single-column test passed with nine of the ten
// columns deleted from the list; this seeds one survivor per column,
// iterating the real exported list, all backdated past the liveness
// window so only ownership is under test. Discriminates a broken CHECK,
// not an edited LIST - the assertion above covers that.
```
