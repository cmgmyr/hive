# Attic: test/lead-moved-pane.test.mjs

Comments removed from `test/lead-moved-pane.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 276 (counselors opus #2). cmdLead used to consume window membership as
// a BICONDITIONAL: a lead pane that was not a member of the project's stamped
// window read as "gone", with rowLive never consulted on that path, so a live
// lead pane that had merely MOVED got a second claude split in beside it -
// both under one HIVE_AGENT_ID, both writing hook rows, which is the exact
// damage cmdLead's CAS exists to prevent, arriving through a door the CAS
// cannot see (one process records both panes, so nothing races).
//
// `tmux break-pane` is the reachable way in and needs no upgrade to construct:
// it is how you get the lead full-screen. Its new window carries no ownership
// stamp; the old window keeps one for as long as anything else holds it open.
//
// The direction test/lead-window-ownership.test.mjs pins is the OPPOSITE one
// (a stale target pointing into ANOTHER project's window must still be
// refused), and both must hold at once: liveness is primary now, ownership is
// the exclusion. Neither file makes the other redundant.
```

## line 33

```
// Panes in this session whose start command is the fake claude. The lead is
// the only thing launched that way here, so this counts LEADS - the fact the
// finding is about ("a SECOND claude split in beside it"), which neither the
// agents row nor a pane count can state on its own: the row names one pane by
// definition, and a pane count cannot say what is running in them.
//
// Never assert this is 1 without first asserting the baseline is 1 too. A
// format tmux answered empty for would make every "exactly one" assertion
// here pass by counting nothing at all - test/CLAUDE.md's fifth shape, a test
// that cannot fail.
```

## line 76

```
// A second pane in the project's window, standing in for the split
// worker that keeps a window (and its ownership stamp) open after the
// lead's own pane leaves. Without it, break-pane below would destroy
// the stamped window along with the stamp, which is a different case:
// the finding is about a live pane whose OLD window survives.
```

## line 82

```
// -d so the new window does not become current: what is CURRENT must
// not decide anything here, and a test that leaves it pointing at the
// moved pane could pass on a code path that only ever asks tmux which
// window is current.
```
