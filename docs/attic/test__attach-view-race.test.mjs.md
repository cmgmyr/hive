# Attic: test/attach-view-race.test.mjs

Comments removed from `test/attach-view-race.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 279 (counselors codex #4). resolveAttachTarget used to read
// `list-clients` and branch on it, returning an argv its CALLER executes
// later: two terminals attaching at the same instant both read zero clients,
// both got a plain attach, and both landed on the base session - the
// two-clients-on-one-session fight the view session exists to prevent,
// recreated by the check meant to avoid it.
//
// The read is gone; every outside-tmux attach takes its own view session. The
// race is unreachable rather than narrowed, and this test still races two real
// processes ON PURPOSE: what it guards against is a later lane reintroducing a
// list-clients read, and only a concurrent fixture can see that. It asserts
// over what HAPPENED to the base session while both clients were live - zero
// clients on it, its current window unmoved - not over a sample of the state
// afterwards.
//
// The clients are control-mode (`tmux -C`), which is how this suite attaches
// without a terminal (test/view-session.test.mjs, test/attach-mode.test.mjs).
// Each child observes while its own client and its peer's are both up, then
// reports; observing from the parent afterwards would be reading a state both
// clients had already left.
```

## line 58

```
// A second window, left CURRENT. Base's current window is the thing a
// stray `select-window -t <base>:<window>` moves, so it has to start
// somewhere other than the project's window for "unmoved" to mean
// anything at all.
```

## line 181

```
// isViewSessionName, not a literal /view-\d+$/: a bumped view
// (freeViewSessionName, issue #117) is a view session this process
// asked for exactly as intended, not a fault - see the identical
// reasoning next to the imported cleanup calls above.
```

## line 201

```
// Built from the actual view name, not a /view-\d+/ shape (same
// defect class as the myView check above: a bumped name broke this
// too, verified separately, and was not named in the original
// finding). Stronger than a shape match besides - it proves THIS
// view got the option, not merely that some view-shaped name did.
```

## line 208

```
// Issue #117 counselors, F4. The two checks above pin the STRING
// asking for the option; this reads whether it actually TOOK EFFECT
// on the live session, read from inside the child while its own
// client was still up (destroy-unattached fires the instant a
// client-less session gets it, so a read from out here, after
// results resolve, would find nothing left to read - see the
// comment above the child script that collects this).
```

## line 221

```
// The base session outlived both clients detaching, which is the whole
// reason that option must never be set on it: leads run detached, and a
// destroy-unattached on the base would take the session and every lead
// in it the moment the last client left. has-session EXITS NONZERO when
// the session is gone, so this fails by throwing rather than by
// comparing two strings that cannot disagree.
```

## line 234

```
// Issue #117 counselors, F4. Dropping `-t =<base>` from the created
// session (a standalone session rather than one grouped with base)
// passed every OTHER assertion in this file before this one existed -
// none of them can tell a grouped view from an ungrouped session that
// merely happens to be named the same shape. Read from inside the
// child for the same reason destroyUnattachedValue is (see above).
```

## line 253

```
// Issue #117 counselors. A two-process race fixture for attachScripts lived
// here for three CI rounds and flaked on alternating ubuntu legs each time -
// round 2 red on node 22 and green on node 24, round 3 the opposite, same
// commit shape, no product change between rounds. The failure was the child
// dying at process startup (empty stdout, exit 1, well under half a
// second), never an assertion about base clients - harness instability, not
// the concurrency property finding anything.
//
// Cut deliberately rather than chased further: the invariant it asserted is
// ORDER-INSENSITIVE (counselors, opus), so a single process proves the same
// thing a race would, and what this fixture actually added beyond M1-M3
// (test/attach-mode.test.mjs) was reading LIVE tmux state instead of the
// emitted string - kept as a single-process test there
// ("attachScripts' live tmux behaviour..."), not lost. The sibling race
// block above, for resolveAttachTarget, predates this lane, was never the
// one flaking, and is untouched.
//
// Do not rebuild the attachScripts race fixture on the strength of this
// comment alone; it did not hold still across three real attempts.
```
