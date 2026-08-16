# Attic: test/tmux-socket-foreign.test.mjs

Comments removed from `test/tmux-socket-foreign.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 10

```
// Issue #73, todo 211 (step 2 of the lane): D2/D4/D6 on plan-73-tmux-socket.
// A row whose recorded tmux_socket disagrees with the one THIS process would
// talk to must read as UNKNOWN liveness everywhere hive decides "is this row
// alive" - never as dead, or the janitor (and everything downstream of it)
// destroys state it cannot honestly judge. D4 is the trap this file exists to
// pin: targetAlive/targetLive returning a plain boolean used to be safe to
// read with `!`, and rowAlive/rowLive returning Liveness (boolean | null) for
// exactly this new foreign case means every `!` at a call site had to become
// an explicit `=== false`/`=== true` check, or a foreign row gets swept as
// dead instead of held as unknown.
//
// Each test below pairs the new refusal with the SAME scenario under a
// matching socket and a legacy empty socket, per test/CLAUDE.md's own rule:
// a test that only asserts the refusal cannot tell a real fix from a
// predicate hard-coded to always return null.
```

## line 101

```
// Deliberately garbage targets: if either function tried to ask tmux
// about them first, this would still pass by coincidence (tmux would
// just say "no such pane"). The point is that foreignSocket alone
// decides this, before targetLive/targetAlive ever run.
```

## line 208

```
// Counselors round 2, R2-1. The ORIGINAL F1 fix filtered this join with
// `AND agents.status = 'running'`, which also drops the ONLY row for an
// actor_id when that row is closed with no running successor at all -
// closeAgentRow() never cancels the actor's timers, so this is reachable
// any time a worker or command row closes while a wake naming it is still
// pending. Filtered out, the join misses, deliver_socket reads '' (local),
// and this test's foreign fact goes unread. Without the fix (a bare
// status filter instead of the preferred-row subquery) this test cancels
// the timer instead of holding it, because the row's foreign socket never
// reaches the query at all.
```

## line 260

```
// ensureLeadRow (src/cli.ts) reuses a closed lead row's own actor_id for
// the row that replaces it, so one project can have many agents rows -
// at most one of them running - sharing a single actor_id. Without
// AND agents.status = 'running' on DELIVER_SOCKET_JOIN, that join is
// one-to-many: this fixture's closed row (recorded on THIS process's own
// socket) matches the same timer as the running row (recorded on a
// FOREIGN one), and whichever candidate the closed row produced reads as
// local.
```

## line 287

```
// livePane is real and alive on THIS process's own (isolated) tmux
// server, standing in for the coincidental pane-id collision the
// counselors finding depends on: the running lead's ACTUAL pane lives
// on the foreign server; this id merely happens to also be alive here.
```

## line 317

```
// Counselors round 2, R2-1. Same regression as the janitor's timers sweep
// above, on the delivery path this finding actually names: closeAgentRow()
// never cancels the actor's timers, so a lone CLOSED row's foreign socket
// has to keep being read after the row closes, not discarded the moment
// no running row shares its actor_id. livePane stands in for the
// coincidental pane-id collision the finding depends on: the closed row's
// real pane lived on the foreign server; this id merely happens to also
// be alive here, on the server tick() would actually type into.
```

## line 359

```
// Every recorded value is `tmuxSocketPath(TMUX, TMUX_TMPDIR)`, computed
// fresh on every read (foreignSocket calls it live, never a cached
// constant). Before the fix, tmuxSocketPath's own `canonical()` ran
// realpathSync on the FULL socket path - the leaf "default" file itself -
// which tmux can transiently unlink and recreate with the server's
// identity completely unchanged. `linkDir` below aliases `scratch` under a
// different name, standing in for exactly the kind of string mismatch a
// real macOS box produces for free (/tmp vs /private/tmp): two path
// strings naming the SAME real directory.
```

## line 376

```
// Computed independently of tmuxSocketPath itself (plain node:fs
// realpathSync on the directory these fixtures actually built), so it can
// pin what the resolved value must BE, not merely that two calls agree
// with each other. Counselors round 2, R2-3: without this, a
// canonicalSocketPath hard-coded to return one constant string passes
// every assertion below - the only earlier check in this file was
// self-agreement (`viaReal === viaAlias`) and a "does not contain this
// substring" match, both of which a constant satisfies trivially.
```

## line 392

```
// Neither path's leaf ("default") has ever existed - the strongest form
// of "unlinked". Old code's canonical() would realpathSync-fail on both
// full paths and fall back to each RAW string verbatim, so the two would
// disagree (one still carrying the "hive-f3-alias-..." segment). The fix
// only ever realpaths the containing directory, which resolves the
// symlink regardless of the leaf's existence.
```

## line 401

```
// Counselors review (both seats, independently): a `doesNotMatch(viaAlias,
// /hive-f3-alias/)` used to sit here, annotated as immune-by-probability.
// Removed rather than kept: it added no protection this equality does
// not already give. Any regression that left the alias segment in
// viaAlias also makes it disagree with expectedSocket (built
// independently from `scratch`, which never carries that segment), so
// the exact-equality check below already catches the identical failure
// - more informatively, since it names both strings instead of just
// ruling one substring out. Node asserts run in order, so the removed
// check could only ever have failed FIRST and masked this one; it could
// never be the assertion that alone caught a real regression.
```

## line 416

```
// This time the leaf genuinely exists at the ALIASED path when first
// read - reproducing a real spawn: TMUX pointed at the alias, the socket
// was live, canonical() resolved the full path (following the symlink)
// and recorded it. Then the leaf is removed while the server (the
// directory) is still there, the exact "unlinked but still running" case
// counselors F3 names.
```
