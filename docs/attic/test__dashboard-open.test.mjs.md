# Attic: test/dashboard-open.test.mjs

Comments removed from `test/dashboard-open.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 356. `hive attach` (cmdAttach, src/cli.ts) opens a project's dashboard
// in a browser the FIRST time it is run in a rolling ~8h window, gated on
// hive.yml's `dashboard: true` with no new config value (Chris's own call,
// todo 356 body). Idempotence comes from a kv TTL marker rather than from
// `open` itself: comments 815/816 measured `open` on this file:// URL to
// duplicate a browser window on every call, deterministically, never
// focusing an existing one.
//
// `open` is faked on PATH via makeFakeOpen (test/helpers.mjs), the same
// shape test/auto-attach-scope.test.mjs uses for osascript: a real `open`
// would pop a real browser window on whatever machine runs this suite, which
// is both undesirable in CI and the very interruption a human "hive at the
// keyboard" measurement (not an automated probe) already covered.
//
// KNOWN GAPS, not covered here and said out loud rather than left implicit:
// the concurrent-double-attach race the atomic conditional UPSERT in
// maybeOpenDashboard closes has no test - reproducing two real processes
// racing the same millisecond is disproportionate to this lane, and the fix
// mirrors an idiom (CLAUDE.md's own Invariants: "wake-up claims are atomic
// conditional updates") already exercised elsewhere rather than inventing new
// logic that would need its own proof. And per the accepted-residual comment
// at the call site, nothing here forces a real pty to exercise the
// headless-invocation gap, on the same grounds
// test/attach-caller-session.test.mjs already declined to for callerSession().
//
// The `hive lead` / bare `hive` trigger - the one the todo actually asked
// for - and the `--no-dashboard` flag live in test/dashboard-open-lead.test.mjs
// instead of here; this file owns the underlying gates
// (darwin/hive.yml/file-existence/containment/kv-marker/TTL) via cmdAttach,
// which both entry points share.
```

## line 57

```
// The positive cases actually call macOS `open` (faked on PATH); on a
// non-darwin box the platform gate returns before any of that, so those
// cases would fail on CORRECT code rather than broken code (counselors,
// codex). Matches test/auto-attach-scope.test.mjs's own `runnable` gate for
// the identical reason - ensureAttached is darwin-only too.
```

## line 93

```
// Same shape maybeGenerateDashboard's own resolveDashboardDir test
// guards on the write side (scheduler.test.mjs's "counselors P1"
// block) - the open path now reuses that exact function, so this pins
// the reuse rather than re-deriving the attack.
```

## line 114

```
// Clean up before the next case, which needs an ordinary directory at
// this same path.
```

## line 121

```
// Counselors, round 3 (posted four times before it was read - see
// todo 356's record). Different from the case above: here
// .claude/dashboard is a REAL, contained directory - resolveDashboardDir
// returns it immediately and never inspects what is inside - so the
// escape has to be closed one level deeper, at the file itself.
```

## line 146

```
// Clean up before the next case, which needs an ordinary index.html at
// this same path.
```

## line 172

```
// Pins the ~8h TTL itself, not just "some TTL was set" (counselors,
// codex): a marker that expired in 5 minutes or 80 hours would pass a
// bare truthiness check.
```

## line 217

```
// failBin first: this "open" exits 1 and never logs, so a call that
// reaches it is indistinguishable from a call that reaches nothing -
// exactly the browser-launch failure this case exists to simulate.
```

## line 267

```
// Positive control (counselors, claude-opus-5, F2): without this, "no
// open call" is equally true if the dashboard:false gate fired, or if
// dirs2's project resolved wrong, or for any other reason attach bailed
// early. Flipping the SAME project to dashboard: true and re-running
// proves the earlier zero was this gate specifically, not an accident.
```
