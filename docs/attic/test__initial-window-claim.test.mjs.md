# Attic: test/initial-window-claim.test.mjs

Comments removed from `test/initial-window-claim.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 278 (counselors codex #1), the most destructive finding of its round.
//
// claimInitialWindow used to find "the initial window" with
// `list-panes -t =<session>`, which resolves the session's CURRENT window
// rather than the one the caller created - and `new-window` makes its result
// current. Project A creates the session; project B creates and stamps its own
// window in it before A gets to the claim; A's lookup then resolves B's
// window, A overwrites B's stamp and runs `respawn-pane -k`, KILLING LEAD B
// and putting lead A in its place. Both lead rows then name one pane, and B's
// liveness probe succeeds because that pane is alive, so B's sends and wakes
// go to A.
//
// WHAT THIS FILE CAN AND CANNOT PIN, stated rather than implied. The
// interleaving itself is no longer reachable between two hive processes on one
// store: todo 277's withWindowClaim serializes ensureSession and the claim
// together, so an end-to-end race between two `hive lead` runs would now pass
// with this fix reverted, for the other fix's reasons. A test that cannot fail
// for its own reason is worth less than no test (test/CLAUDE.md), so the first
// describe below pins the MECHANISM deterministically instead: the claim
// targets the ids it was handed, with another project's window sitting there
// as the current one. That is what stays true no matter who else is holding
// the lock - a human running `tmux new-window` in hive's session takes no lock
// at all.
//
// The second describe covers ensureSession's own check-then-act directly,
// racing real processes against it rather than against any caller. Pad 79
// T5(b) put the last caller that reached it unguarded (`hive attach`) inside
// withWindowClaim too, so every production call now serializes through that
// exclusion and this race is no longer reachable end to end through any of
// them - see ensureSession's own comment (src/tmux.ts) for why the handling
// stays regardless: it is defence in depth for a future call site added
// outside a withWindowClaim section, and this file is what keeps it tested
// on its own rather than only through callers that can no longer exercise it.
```

## line 52

```
// hive's own tmux wrapper, deliberately, for the one assertion below that
// is ABOUT its error type: the raw execFileSync helper throws a plain
// Error, and isDuplicateSession takes a TmuxError. Everything else in this
// file checks hive's work with the suite's independent tmux() instead.
```

## line 77

```
// The other project arrives between the session's creation and the
// claim, exactly as codex's interleaving describes: its window is
// stamped for a different project and, because new-window makes its
// result current, it is what "the current window" now resolves to.
```

## line 87

```
// Without this the test could pass against the old code purely because
// new-window did not move the session's current window - the fixture
// would then be reproducing nothing and every assertion below would be
// vacuous.
// list-windows, not `display-message -t =<session>`: that answered
// empty here, and .claude/rules/tmux-and-panes.md already records that
// display-message falls back silently rather than failing on a target
// it cannot resolve.
```

## line 138

```
// A hand-built TmuxError would only prove the regex matches the string
// this test wrote. The point is the string TMUX writes, which is the
// half that can rot under a tmux upgrade.
```

## line 149

```
// The control: any OTHER tmux failure must NOT read as a duplicate,
// or ensureSession would swallow real failures as lost races.
```

## line 162

```
// Static imports are hoisted ABOVE raceProcesses' barrier, so both
// children finish loading dist/ before either one starts spinning and
// they reach ensureSession within microseconds of each other. Two calls
// in one process would prove nothing here: the first would always
// complete before the second began.
```
