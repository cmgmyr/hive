# Attic: test/lead-pane-reissued.test.mjs

Comments removed from `test/lead-pane-reissued.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Todo 336. Pane ids restart from %0 when a tmux server exits and a fresh one
// starts on the same socket path - measured directly, and recorded on the
// todo. deliverable()'s old lead-pane-dead hold (HELD_REASON_LEAD_PANE_DEAD)
// only fires when the recorded pane reads DEAD; a reissued pane reads LIVE,
// so a pending lead-owned wake used to sail through and type into whatever
// pane the new server handed that id to next - a stranger's pane, not the
// lead's.
//
// THE FIXTURE IS THE WHOLE POINT (the lane's own plan pad, pad 112). A test
// that only checks "matching pid delivers, mismatched pid does not" tests the
// CONDITION this lane wrote, not the DEFECT todo 336 describes. So the first
// test below reproduces the real sequence measured on the todo: record a
// lead-owned wake against a real pane, kill every session so the server
// genuinely exits, start a fresh one on the same socket, and assert the wake
// does not land on whatever that fresh server's first pane turns out to be -
// no synthetic AliveSnapshot standing in for tmux's own restart behaviour.
```

## line 38

```
// Independent of dist/tmux.ts on purpose (test/CLAUDE.md's own rule for
// assertion helpers): this file's whole point is to prove what a pane
// carries, so it has to ask tmux directly rather than through the code under
// test. list-panes, not display-message, matching src/tmux.ts's own reason
// (display-message silently answers for a different target on a dead one;
// list-panes just errors).
```

## line 95

```
// Issue #149 (todo 348). Same shape as insertLeadRow, kind='agent' instead of
// 'lead' - the whole point of this lane is that the janitor and the
// pane-identity hold both used to treat this row differently from a lead's.
// RETURNING id, unlike insertLeadRow, because the worker-owned test below
// also checks that the widened janitor sweep reaps this row. created_at is
// backdated past janitor()'s own SETTLE_WINDOW (-15 seconds, src/scheduler.ts)
// for the identical reason insertDueLeadWake backdates its timer: that grace
// period exists to stop a freshly-spawned worker racing its own window
// creation, and this row is not that race - a row created "now" would be
// skipped by the sweep for a reason that has nothing to do with what this
// test proves.
```

## line 126

```
// gen1: the ONLY tmux command this whole file has issued so far against
// this file's private socket (isolateTmux gives every file its own), so
// its pane is deterministically the server's very first: %0. Nothing
// below depends on knowing that number - only on gen2's first pane also
// being ITS server's first, which holds for the identical reason once
// gen1's server is genuinely gone.
```

## line 141

```
// Kill the ONLY session on this socket. tmux's default exit-empty
// setting makes the server exit once no session is left - never
// kill-server directly (test/suite-isolation.test.mjs refuses any file
// but helpers.mjs from calling it, and for the reason stated there: a
// bare kill-server resolves through ambient env and can reach a server
// this file does not own).
```

## line 151

```
// gen2: a BRAND NEW server on the same socket path (the old one is
// gone), so its pane-id counter restarts at %0 exactly as measured on
// the todo. This is what reissues gen1Pane's id to a genuinely different
// process - not a mocked snapshot standing in for it.
```

## line 161

```
// THE FIXTURE'S OWN SANITY CHECK, not an assertion about the code under
// test: prove the reissue actually happened before trusting anything
// that follows. Same id, different process - if either fails, the rest
// of this test proves nothing about todo 336's defect.
```

## line 225

```
// '' is this column's own DEFAULT and its "no fact recorded" reading
// (src/db.ts's migration, TimerRow's own comment) - every row written
// before this lane's migration lands reads this way, and an upgrade
// must not start holding or cancelling every one of them.
```

## line 248

```
// Issue #149 (todo 348). Todo 336's fix above gated the pid-mismatch check to
// LEAD-owned wakes on the claim that a worker row is already reaped by
// janitor()'s sweep before a reissued pane matters. That claim was false: both
// janitor sweeps only ever acted on `rowAlive(...) === false`, and a reissued
// pane reads LIVE, so a worker's wake could sail straight through into
// whatever pane inherited its id after a restart. Same real-sequence shape as
// the DEFECT test above (kill every session, start a fresh one on the same
// socket) - a hand-built snapshot would only prove the condition this lane
// wrote, not the defect issue #149 describes.
```

## line 281

```
// THE FIXTURE'S OWN SANITY CHECK, matching the lead test above.
```

## line 308

```
// Step 4 of issue #149, same tick: the widened agents sweep must reap
// this row rather than leave it reporting "running" - agent_list,
// agent_send's requireLive and watchedTail all still poisoned by a
// surviving row even with delivery itself held.
```

## line 322

```
// Fix round 1, finding 1 (counselors, both seats). A hold for pane-reissue
// used to be only a ONE-TICK promise: once the pane the wake was reissued
// to also exits - a transient shell, often within minutes - the janitor's
// timers sweep saw rowAlive === false and cancelled the timer outright for
// a non-lead actor, exactly as it always has for an ordinary dead pane.
// The wake then left ACTIVE_TIMER_WHERE with no fired_at, dropping out of
// wake_list's pending section and hive status's heldWakes with nothing in
// recently_delivered either - silently gone, through the door on the OTHER
// side of the hold-vs-cancel decision.
//
// A THIRD session on gen2's server is required so killing gen2Session
// alone leaves the server reachable: killing the server's only session
// makes it exit entirely, and a probe against an unreachable server reads
// `null` (unknown), never `false` (confirmed dead) - the janitor never
// acts on null. Killing one session while another survives on the same
// server is what makes list-panes answer "can't find pane" for gen2Pane
// specifically, the CONFIRMED-dead case this fix is about.
```

## line 368

```
// The reissued pane's own session exits - the SAME kind of event that
// reissued gen1Pane in the first place, now happening to gen2Pane. The
// anchor session keeps the server itself reachable.
```

## line 408

```
// Fix round 1, finding 3 (counselors). The "no fact recorded" case for
// pane_pid = '' is already pinned for deliverable() (the "todo 336" describe
// block above, "a pre-migration row (pane_pid = '') is never treated as a
// mismatch"), but that test seeds a kind='lead' row - the janitor's agents
// sweep filters `kind != LEAD_KIND`, so a lead row never reaches the branch
// this lane added there. Nothing in the suite proved the SAME "no fact,
// don't touch" reading holds on the agents-sweep side for a worker row,
// which is exactly the row every pre-todo-336 store is full of. Drop
// `recordedPid !== ""` from paneReissued (src/tmux.ts) and this test goes
// red: the first tick after upgrade would read every pre-migration worker
// row's live, non-empty current pid as a "mismatch" against its recorded
// '' and close every one of them - the exact hazard src/db.ts's migration
// comment warns about, reached through the sweep this lane added rather
// than through deliverable().
```

## line 430

```
// '' is this column's own DEFAULT and its "no fact recorded" reading
// (src/db.ts's migration, TimerRow's own comment) - the pane is
// genuinely alive and has never been restarted, so this is exactly the
// ordinary case for a row hive wrote before todo 336's migration ran.
```
