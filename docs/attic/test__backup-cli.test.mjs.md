# Attic: test/backup-cli.test.mjs

Comments removed from `test/backup-cli.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 11

```
// Issue #23. `hive backups` and `hive restore` themselves never touch tmux,
// but runCli spawns hive, and every hive command runs migrate() first; the
// suite's own isolation guard (test/suite-isolation.test.mjs) does not
// distinguish by subcommand, so isolate like every other runCli-based file.
```

## line 23

```
// Every hive command runs migrate() first, and a fresh store has every
// migration pending, so the very first command against this store already
// leaves one "migration" snapshot behind for `hive backups` to list.
```

## line 32

```
// No TTY, no --yes: must refuse rather than hang on a prompt nothing will answer.
```

## line 41

```
// PR #36, S2: restore takes one more snapshot of the store as it stood
// right before overwriting it, since restore is itself the kind of
// mistake this whole feature exists to have a way back from.
```

## line 53

```
// PR #36, S1. Restore replaces the whole store out from under any live
// connection; SQLite's own docs call renaming a fresh inode over an open
// database, and unlinking its shared -wal, undefined behaviour. This gate
// makes "restart your other sessions first" enforcement rather than advice.
```

## line 62

```
// `hive backups` alone never registers a project (it never calls
// resolveProject()); `hive pads` does, and this test needs a real
// project row to attach the fake running agent to.
```

## line 70

```
// A fake running agent, written directly to the store: this test is
// about the CLI's own gate, not about spawning a real tmux worker.
```

## line 84

```
// Issue #49: --force is weak protection on its own (it cannot see a
// session that started outside hive, or one that starts in the gap
// between this check and the overwrite), so the message has to name what
// choosing it actually costs. Two different servers pay differently: a
// same-version one refuses at its next tool call once storeReplaced()
// trips; an older one has no such guard and keeps writing until it exits.
```

## line 101

```
// Issue #27's L4 fix round R9, todo 176 (BOTH SEATS, codex HIGH). This used
// to probe the lead's own pane (targetAlive against a liveTargets()
// snapshot, todo 173), on the premise that status='running' alone cannot
// tell a live lead from one whose session ended hours ago (DECISION 3).
// That premise is still true, but cross-server liveness turned out
// unanswerable by probing: an empty snapshot means either "no server at
// all" (the ordinary post-reboot state, exactly when someone restores a
// backup) or "the wrong server" (a live lead on a different one), and
// nothing in a bare AliveSnapshot tells those apart. So this stops probing
// entirely - a running lead row refuses UNCONDITIONALLY now, dead pane or
// not - and the way out is a human retiring the row (agent_close, see
// test/agent-close-lead-guard.test.mjs), not a liveness guess.
```

## line 138

```
// The pane is now genuinely dead, and restore must STILL refuse: no
// probe means no exception for a dead pane either, only for a
// deliberately closed row (below). This is the load-bearing assertion
// for the redesign - the previous version of this test asserted the
// opposite here.
```

## line 147

```
// Issue #27's L4 fix round R10, todo 182 item 2 (opus F4). agent_close is
// an MCP tool, not a `hive` CLI verb the person reading this refusal at a
// bare terminal could just run.
```

## line 156

```
// The deliberate retirement path itself (agent_close on a confirmed-dead
// lead) is exercised directly in test/agent-close-lead-guard.test.mjs;
// only its EFFECT on restore - a closed row - matters here.
```

## line 169

```
// Issue #27's L4 fix round R9, todo 176 HALF 1 (the lead's own regression
// finding, verified against the code). The reboot case: no tmux server
// answers at all, which is what a live server ALWAYS eventually becomes
// once its last session closes (tmux ships exit-empty on) - not an
// exotic edge, the ordinary state right when someone restores a backup.
// R8's snapshotEmpty rule refused here too, but by accident (an empty
// liveTargets() snapshot) and with --force as the only way out, which also
// disabled the runningNonLeads check above. This refuses because the row
// is running, full stop, with no tmux call involved in the decision at all.
```

## line 182

```
// registers a project row
```

## line 195

```
// A socket directory that has never had a tmux server started on it -
// "no server running", the same answer a machine gives right after a
// reboot.
```

## line 211

```
// Todo 375, PR gate round 1 finding 3, one command over. `hive restore`
// bounded its `tmux ls` in this lane and went on swallowing a TIMEOUT with
// the same catch that swallows "tmux is not installed" - so against a wedged
// server it computed NO tmux reason and proceeded, and this is the path that
// OVERWRITES THE STORE. Doctor's version of that bug produced a misleading
// line; this one produces data loss.
//
// The pair matters more than either half. A test that only proved the
// blocker appears would pass just as well against a version that blocks on
// EVERY tmux failure, which would refuse restore on every machine with no
// tmux installed - the ordinary case this catch was written for.
```

## line 235

```
// Hangs only on `ls`, so everything else in this run reaches the real
// tmux and the refusal below can only be about the read under test.
```

## line 245

```
// The remedy has to be reachable, the same way the lead-rows reason
// above it names agent_close rather than only --force.
```

## line 249

```
// --force stays the escape hatch it already is for every other reason
// here; this one must not become a wall.
```

## line 260

```
// COUNSELORS ROUND 2, F3. The blocker's condition was `e instanceof
// TmuxTimeoutError`, which is the timeout SHAPE rather than the unknown
// CLASS: EACCES spawning tmux, ENOBUFS, a transient socket error all
// arrive as an ordinary TmuxError matching nothing, and each one used to
// pass in silence on the path that OVERWRITES THE STORE. The condition is
// tmuxSaysNothingThere now, so an unrecognised failure blocks exactly the
// way an unanswered one does. No timeout is involved here: the fake exits
// 1 at once.
```

## line 278

```
// The unrecognised failure is quoted, because "tmux did not answer" on
// its own sends a human hunting for a wedged server that is not there.
```

## line 287

```
// The other half of the pair above, and the one that keeps the widened
// condition from becoming "any tmux failure blocks". A server that
// answers "there is no server" is a fact about the world - nothing is
// running - and restore must proceed on it.
```

## line 308

```
// A PATH with node and no tmux at all: `tmux ls` fails with ENOENT,
// which is an ANSWER about the world (nothing tmux manages is running)
// rather than an unanswered probe. That case degraded to silence before
// this fix and must keep doing so, or every machine without tmux loses
// the ability to restore without --force.
```

## line 323

```
// Issue #27's L4 fix round R10, todo 182 item 1 (codex F4). The two describe
// blocks above both refuse restore over an EMPTY tmux snapshot (no server,
// or a server nobody has ever started a session on) - and the pre-R9 code
// they replaced refused there too, by accident, via its own snapshotEmpty
// rule. Reverting the R9 fix and rerunning either test above still goes
// green, so neither one actually pins the redesign; they only pin "restore
// refuses when nothing is reachable," which both versions already did. The
// distinguishing case is a POPULATED snapshot that simply does not contain
// this row's target - the wrong-server case R9 exists for - and nothing in
// this file exercised it before now.
```

## line 340

```
// registers a project row
```

## line 353

```
// A REAL, reachable, non-empty tmux session - so liveTargets() answers
// a populated snapshot, not null and not empty - that simply has
// nothing to do with this row's pane. Named so it does NOT start with
// SESSION_PREFIX ("hive-"), or the OTHER signal activeHiveUsage checks
// (a live hive-* session) would refuse for an unrelated reason and this
// test would stop discriminating anything about the lead-row signal at
// all.
```

## line 375

```
// PR #36, C2. HIVE_BACKUP_KEEP_LAST=1 makes the bug reproducible with one
// snapshot instead of ten: without protecting the restore target, the
// pre-restore "manual" backup this call takes would itself be the only
// snapshot retention keeps, pruning the very thing being restored before
// restoreSnapshot ever looks for it.
```
