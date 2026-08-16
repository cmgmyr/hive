# Attic: test/layout.test.mjs

Comments removed from `test/layout.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 67

```
// isolateTmux isolates the socket, not ~/.tmux.conf. Force and re-read
// both globals after the server exists so the positive assertions cannot
// pass from this machine's real configuration.
```

## line 82

```
// Through ensureSession, which is where the pane and window ids
// claimInitialWindow claims now come from (todo 278): it targets what it
// was handed rather than asking the session which window is current.
```

## line 96

```
// A stale target must not borrow another window's ownership marker.
// display-message silently falls back here; list-panes errors instead.
```

## line 125

```
// STATE THE GEOMETRY THIS TEST DEPENDS ON RATHER THAN INHERITING IT.
// isolateTmux isolates the SOCKET, not the config: tmux reads the
// developer's own ~/.tmux.conf when the scratch server starts. A pane
// border costs every pane a row, so a developer who follows the raw-attach
// advice hive itself now prints (docs/tmux.md, `hive setup --attach raw`)
// saw this assert 49 against 50 and had no way to tell it from a real
// regression. The recommended setting gets its own case below.
```

## line 149

```
// Closing takes the same path agent_close does: resolve the window from
// the pane first, kill it, then re-apply the layout hive recorded.
```

## line 170

```
// Hive applies pane-border-status top to its own windows, so its layout
// has to survive the row that border consumes. The setting itself is
// pinned by the ownership case above; this case pins the geometry.
```
