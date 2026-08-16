# Attic: test/worker-first-window-stamp.test.mjs

Comments removed from `test/worker-first-window-stamp.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// The placement="window" sibling of test/worker-first-window-naming.test.mjs
// (that file's own header explains why this needs its own file: a session
// that does not exist yet, which no other lead-*.test.mjs file starts from).
// A worker's own dedicated window (placement="window") must never carry
// @hive-project-id: that stamp is cmdLead's and splitTargetWindow's lookup
// key for "the project's shared window", and stamping a worker's PRIVATE
// window with it hands a later `hive lead` (or another split-placed worker)
// that private window to land in, defeating placement="window" outright.
```

## line 24

```
// show-options errors ("invalid option") on a custom option that was never
// set anywhere, rather than answering empty - measured live against a real
// tmux while building todo 265/266 (.claude/rules/tmux-and-panes.md). Read
// that as "unset", the same as an empty stamp.
```

## line 61

```
// todo 371: a row's tmux_target is a PANE id for every placement now, so
// the window has to be resolved from that pane. Reading it off the receipt
// made this comparison a pane id against a `session:@n` string, which can
// never be equal - the assertion below stopped being able to fail.
```
