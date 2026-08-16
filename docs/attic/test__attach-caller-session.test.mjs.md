# Attic: test/attach-caller-session.test.mjs

Comments removed from `test/attach-caller-session.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 279 (counselors codex #3 and opus #1 independently, so certain).
//
// `hive <project>` from inside tmux ran `select-window -t <window>`, where the
// window came from findProjectWindow already qualified with the BASE session's
// name. select-window on a session-qualified target moves THAT SESSION's
// current window, so from a pane being viewed through a VIEW session it moved
// BASE's current window - yanking the other terminal to a window nobody there
// asked for - while the caller did not move at all. Both halves are wrong at
// once, which is why this file asserts both.
//
// NO CLIENT IS ATTACHED HERE, deliberately, and that is what makes the test
// deterministic. A session's current window exists whether or not anyone is
// looking at it, so the yank is observable without a terminal; and with no
// client, callerSession() falls through to $TMUX's own session id, which a
// test can set exactly. The client_session read that sits AHEAD of that
// fallback is measured rather than tested (its measurement is in
// callerSession's own comment: attaching a real client needs a pty, which
// differs between the macOS and ubuntu CI legs).
```

## line 60

```
// Both sessions parked on the OTHER window, so "moved" and "unmoved"
// are distinguishable in both directions.
```

## line 66

```
// What a pane's environment looks like: <socket>,<server pid>,<session
// id>. Built from the real server rather than a literal, since the
// first field is what hive's own foreign-socket guard reads.
```

## line 71

```
// list-sessions, not `display-message -t =<name>`: measured here, that
// form answers EMPTY for #{session_id} while the bare name answers
// `$1`. Same trap .claude/rules/tmux-and-panes.md already records for
// display-message, in its quieter direction - no error, just nothing.
```

## line 85

```
// Any view session this run left behind, not just the fixture's own:
// the fallback branch under test creates one named for the CLI's pid.
```
