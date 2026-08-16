# Attic: test/tmux-socket.test.mjs

Comments removed from `test/tmux-socket.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 18

```
// Issue #73, todo 210 (step 1 of the lane): every write of tmux_target must
// write tmux_socket in the same statement, from tmuxSocketPath() - the same
// function untrustedTmuxServer() already decides server identity with. This
// file proves the WRITE side only (D5 on plan-73-tmux-socket): a fresh
// launchAgent spawn carries this process's socket, and a lead row re-records
// the socket on every restart, including one that lands on a genuinely
// different tmux server. The read-side gate (foreignSocket, D6/D7) is a
// separate lane (todo 211) and is not exercised here.
```

## line 61

```
// Non-empty: a constant '' would satisfy an equality check against a
// process whose own socket happened to canonicalise to '' by mistake,
// which is not a risk this assertion alone can rule out, so pin the
// shape of a real recorded fact first.
```

## line 110

```
// A second, genuinely separate tmux server: a fresh TMUX_TMPDIR names a
// socket this suite's ambient one has never touched, so ensureSession
// cannot find the existing session there and creates a brand new one -
// the same shape a real restart under a different tmux takes, without
// faking tmuxSocketPath's own inputs.
```

## line 117

```
// Computed once, ahead of the try: reused for the assertion below AND
// for -S in the cleanup's kill-session, instead of a second copy
// hand-reconstructing tmuxSocketPath's own <base>/tmux-<uid>/default
// layout, which would silently stop matching if that layout ever
// changes.
```

## line 123

```
// Todo 375, counselors round 2 (F6). A real second server on a
// bespoke socket: isolateTmux registers only this file's own, so the
// run-level leak check needs to be told about this one.
```

## line 145

```
// Best effort; exit-empty already tears the server down once its
// one session ends.
```
