# Attic: test/view-session.test.mjs

Comments removed from `test/view-session.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Todo 271 / plan-lane-3-tmux-topology, "VIEW SESSIONS DESIGNED AND SETTLED
// WITH CHRIS". Two clients on ONE shared session fight over its current
// window (pad 71 "SECOND PROJECT, SIDE BY SIDE INSTEAD"), so a second real
// terminal attaches through its own view session instead: same windows,
// independent current window, destroyed the instant its client detaches,
// never touching the base session or any pane in it.
```

## line 40

```
// A headless client, attached in tmux's own control mode (-C). Measured
// against tmux 3.7b: control mode registers a real client (visible in
// list-clients) over plain pipes, no pty required, which is what lets this
// force a SECOND real client onto a session with nothing more than PATH and
// stdio - the standing way to exercise anything needing an already-attached
// session (dead-ends/2026-08-02-ensureattached-against-the-live-session.md
// solved the opposite problem, forcing a session to have NO client; this
// forces one ON).
```

## line 71

```
// Todo 279 (counselors codex #4) COLLAPSED THE TWO BRANCHES THIS USED TO
// ASSERT. There was a no-client branch (plain attach onto base) and a
// has-client branch (a view session), chosen by reading list-clients -
// a read whose answer is executed later, by a caller that spawns the
// returned argv, so two terminals attaching at the same instant both
// read zero clients and both landed on base. Every attach takes a view
// now, so there is no read to be stale and no branch to choose wrong.
// The has-client case further down is unchanged and still passes: it
// was always this shape.
```

## line 102

```
// delta is created SECOND, so base's current window is delta, not
// gamma - deliberately different, so a passing test proves the
// returned argv, once run, actually moves it rather than it already
// happening to be there.
```

## line 120

```
// The property that regressed: calling resolveAttachTarget must not
// itself mutate anything. Only running the argv it returned should
// move the window - proven below by actually running it.
```

## line 130

```
// Same technique the has-client case below uses: a headless -C
// client drives the EXACT argv resolveAttachTarget returned, so a
// passing assertion proves the chain actually works when spawned,
// not merely that its shape looks plausible.
```

## line 172

```
// beta is created SECOND, so tmux's own new-window default (make
// the new window current) leaves base on beta - deliberately
// different from alpha, the project's own window, so independence
// is proven by construction rather than by coincidence.
```

## line 181

```
// resolveAttachTarget does not create the view itself - it is
// created, stamped and navigated as part of THIS returned chain,
// by whoever actually spawns it (see the function's own comment
// for why: creating it any earlier races destroy-unattached).
```

## line 196

```
// Spawned with -C prepended, not -CC: this drives the EXACT
// argv resolveAttachTarget returned, headlessly, over plain
// pipes. -C needs no real pty for this (measured against tmux
// 3.7b); -CC additionally calls tcgetattr and fails outright
// over a pipe ("Operation not supported on socket") - a fact
// about control mode's OWN two levels, unrelated to what this
// case is actually proving (the chained command sequence).
```

## line 209

```
// destroy-unattached is a session option; it must never have
// reached base, which keeps leads running detached (pad 71,
// "ENDING THINGS"). Bare name, not `=session`: measured, `show-
// options -t =<name>` fails outright ("no such session") for
// EITHER side of a grouped pair in tmux 3.7b, while every other
// command used in this file (list-windows, list-clients,
// select-window, set-option) resolves the exact-match form fine
// - a quirk of this one command, not of the session's existence.
```

## line 279

```
// Independent derivation, not a second call to the same function
// (test-hygiene reasoning: dead-ends/2026-08-05-test-hygiene-lane-that-
// dissolved.md, applied here the same way session-name.test.mjs applies
// it to sessionName): a wrong pid or a dropped prefix would still pass a
// test that just called viewSessionName again and compared it to itself.
// sessionName() carries the scratch store's own tag independently, so
// reusing it here (rather than hardcoding "hive-") still catches
// viewSessionName dropping the tag or the prefix on its own.
```
