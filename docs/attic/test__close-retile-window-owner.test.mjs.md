# Attic: test/close-retile-window-owner.test.mjs

Comments removed from `test/close-retile-window-owner.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 269 / plan-lane-3-tmux-topology. agent_close's re-tile
// (src/tools/agents.ts, the applyLayout call after kill-pane/kill-window)
// used to fall back to `loadProjectYml(project.path)` - the CLOSING ROW's
// project - when the window carried no @hive-layout yet. Once a
// cross-project worker can share a window with a lead it did not spawn from
// (todo 268), that resolves a FOREIGN repo's hive.yml against a window it
// does not own: exactly counselors F1 on pad 71, the finding that killed the
// lead's original cross-session placement proposal. The fix routes the
// fallback through the WINDOW's own @hive-project-id owner instead.
//
// windowLayout(window) (the @hive-layout window option) is consulted FIRST
// and already reads correctly in the ordinary case - a spawn's own
// applyLayout call stamps it. So both tests here deliberately UNSET
// @hive-layout after spawning, to force the code down the FALLBACK path this
// todo actually changed; without that, every window here would already
// carry a stamp from its own spawn and the fallback would never run.
```

## line 44

```
// DIFFERENT layouts, deliberately, so a wrong resolution is observable -
// test/CLAUDE.md's "a same-layout fixture cannot fail" rule, named
// directly in the todo's own acceptance criteria.
```

## line 86

```
// A cross-project worker: store scope B, but its pane lands in A's
// window because A's lead spawned it (todo 268).
```

## line 100

```
// Close it as project B would see its own worker - project_id=B,
// matching how a lead orchestrating cross-repo work actually calls
// agent_close (findAgent scopes strictly by project_id).
```

## line 121

```
// placement="window": its own dedicated window, deliberately never
// stamped with @hive-project-id (test/worker-first-window-stamp.test.mjs).
```

## line 143

```
// Closing row's own project is A, whose hive.yml layout ("main-vertical")
// is deliberately NOT DEFAULT_LAYOUT ("tiled") - if the fallback wrongly
// used the closing row's project here, this assertion would catch it
// exactly as the first test does, even though this scenario has no
// owner stamp to compare against at all.
```
