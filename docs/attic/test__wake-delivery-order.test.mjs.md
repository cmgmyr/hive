# Attic: test/wake-delivery-order.test.mjs

Comments removed from `test/wake-delivery-order.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Todo 274 (topology-3c). resolveDelivery's own-session lookup
// (src/tools/wakes.ts) had no ORDER BY on `WHERE actor_id = ? AND status =
// 'running'` - the identical shape splitTargetWindow (src/spawn.ts) already
// carries `ORDER BY id DESC LIMIT 1` for, and for the identical reason (its
// own comment): two running rows should never share an actor_id, but if that
// invariant is ever wrong, a `.get()` with no ordering picks whichever
// SQLite hands back first - in practice, for this unindexed shape, the
// LOWER (older) rowid. Found by 3b's own /simplify altitude pass and
// deferred to this lane because it opens the file.
//
// This also stands in for todo 274's migration question: pane ids are
// SERVER-scoped, so the topology change (one session, not one per project)
// does not invalidate a recorded %N by itself - this test runs entirely
// against the new, store-scoped session (sessionName() takes no project
// argument) and proves delivery still lands on the correct real pane rather
// than assuming it.
```

## line 37

```
// A fixed actor_id, not the McpClient's own default (`user:<os user>`,
// shared with every other file's default-identity server) - each seeded
// row below must belong to THIS test's actor and no other test's.
```

## line 58

```
// The LOWER-id row: same actor_id, a syntactically valid pane id that
// is not actually live - the exact shape splitTargetWindow's own
// comment names (a closed lead's stale tmux_target surviving
// alongside a fresh running row). Inserted FIRST, so a `.get()` with
// no ORDER BY - SQLite's practical default for this unindexed scan is
// insertion/rowid order - would pick this one.
```

## line 69

```
// The HIGHER-id row: same actor_id, a REAL live pane.
```

## line 80

```
// No deliver_to: resolveDelivery's OWN-session branch, the one under
// test, is reached only when the caller wakes itself.
```

## line 91

```
// Not just the column: fire it for real and read the delivery back off
// the actual pane's terminal.
```
