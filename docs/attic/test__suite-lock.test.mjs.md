# Attic: test/suite-lock.test.mjs

Comments removed from `test/suite-lock.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 21

```
// Todo 401. Three lanes ran full suites at once; this file has to prove the
// four things that keep a lock like this from halting a night rather than
// preventing one, not just that a lock file gets written somewhere.
```

## line 66

```
// This has to be separate OS processes, not concurrent promises in one
// process: Node's synchronous fs calls never yield mid-call, so a
// stat-then-create acquire (or a stat-then-remove takeover) never actually
// interleaves against ANOTHER promise in the same process - there is no
// event-loop turn between the two steps for a second promise to run in. Two
// real processes are scheduled by the kernel independently, which is the
// only way this repo can exercise the TOCTOU windows `wx`/`link` close, and
// it is also what "two processes racing for the lock" (todo 401) literally
// describes.
```

## line 78

```
// releasedAt is measured AFTER lock.release(), not before (counselors
// round 1, fable-5): measuring it before release() means a false
// acquisition landing during the gap between the timestamp and the actual
// release call is invisible to the overlap check below. Over-approximating
// the hold window is the safe direction for an assertion whose whole job
// is proving windows never overlap.
```

## line 92

```
// ttlMs bounded (counselors round 2, opus): without this, a real
// regression that produces an unreclaimable lock turns this test into
// a silent 20-minute CI stall instead of a fast, readable failure. 30s
// against a 150ms hold leaves no legitimate case anywhere near it.
```

## line 147

```
// Counselors round 1 (all three seats): the test above starts with NO lock
// file, so every loser sees a live holder and waits - the takeover branch
// (dead-pid, corrupt, invalid-startedAt) is never raced across processes,
// only exercised single-process above. That gap hid a real bug: the
// original `unlinkSync`-based takeover let two waiters who both read the
// same stale holder both "win" - one unlinks the OTHER's freshly-written,
// live lock. Seeding a dead-pid lock and racing every worker against the
// TAKEOVER path closes that gap.
```

## line 165

```
// MEASURED against the unlinkSync-based takeover this replaced: this
// test caught the double-hold 1 run in 13 (5 and 10 workers both tried;
// more workers did not raise the rate - node's own process-startup time
// staggers arrivals enough to swamp the race window more than added
// contenders close it). This is a real, low-probability window, not a
// flake: the mechanism is proven by that one catch plus the takeover fix
// itself being a standard atomic-rename pattern, not by this test's
// catch rate. Kept as regression coverage for the path, not as a
// reliable single-run detector - do not tune worker count expecting a
// higher strike rate; it was tried and did not move the needle.
```

## line 215

```
// Split from the "not json" case above (counselors round 1, opus): that
// one exercises only the JSON.parse-throws branch of readHolder(), never
// the separate "parsed but not a real holder record" branch - dead
// alternation, test/CLAUDE.md shape 1.
```

## line 266

```
// the "other lane" finishes and releases
```

## line 286

```
// Counselors round 1 (opus): the original version of this test only
// re-asserted noLockRequested() itself, which stays green even if
// run-tests.mjs's OWN wiring is deleted or broken - it pinned nothing
// about the wrapper. This reads the wrapper's real source instead, the
// same way suite-isolation.test.mjs pins tmux wiring by reading source
// rather than by running the whole suite recursively.
```

## line 301

```
// Counselors round 2 (fable-5): fix 3 (updateHolderPid) and the release()
// call in the exit handler had NOTHING pinning their call sites - deleting
// either stayed green under every test above, since those only exercise
// the functions in isolation. Ordering matters for both: updateHolderPid
// is only correct once child.pid exists, and release() has to run from
// the SAME handler the manifest cleanup already relies on for every exit
// path (normal, failure, forwarded signal).
```

## line 313

```
// Search FROM the exit handler on, not the first occurrence overall:
// the child "error" handler added alongside it also calls release(),
// for a different, earlier failure path, and that occurrence sits
// before "exit" in the source.
```

## line 327

```
// Counselors round 1 (all three seats): the shape that broke the original
// "any positional arg is cheap" rule. existsFn is injected (a fake
// set, not real fs.existsSync) so this stays a unit test rather than
// depending on real files under test/.
```

## line 350

```
// Counselors round 2 (codex): a suffix match alone still misreads a
// flag's own value as a cheap target when it happens to end in
// `.test.mjs` but was never meant as one, e.g.
// `--test-reporter-destination report.test.mjs` - that destination path
// does not exist yet, which is exactly what existsFn now catches.
```

## line 356

```
// nothing exists
```

## line 362

```
// Counselors round 1 (codex): the lock is acquired before run-tests.mjs
// spawns the process that actually runs the suite, so a liveness check
// against the original holder pid watches the SUPERVISOR, not the
// resource-holding work. A SIGKILL to the wrapper alone would leave the
// still-running child behind a lock that reads as dead and gets reclaimed
// instantly. updateHolderPid repoints the recorded pid once the real
// worker exists, without resetting the TTL clock.
```

## line 387

```
// PR gate finding on this PR: the cross-process race test only reaches
// the mismatch/restore branch probabilistically (~1 in 13 runs), so a
// regression there could stay green on most CI runs. These call
// takeover() directly with a deliberately wrong `expectedRaw` to force
// both branches every time, deterministically.
```

## line 412

```
// PR gate finding (second round): a third test here claimed to pin the
// documented accepted-residual EEXIST branch (a third process recreating
// lockPath between the restore's rename and its own linkSync) but never
// actually reached it - nothing in a single synchronous takeover() call
// can recreate lockPath mid-call without real concurrent processes, so
// `assert.doesNotThrow` passed identically whether that branch existed,
// was deleted, or had its condition inverted. Removed rather than kept as
// a test that cannot fail in the direction that matters (test/CLAUDE.md).
// The residual itself stays documented in the code comment above
// takeover(), which is the honest claim: an accepted, narrow, un-testable-
// without-real-processes edge case, not a guaranteed property to pin.
```

## line 430

```
// Simulate a takeover happening between our write and our release.
```
