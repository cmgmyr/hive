# Attic: test/window-stamp-race.test.mjs

Comments removed from `test/window-stamp-race.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 18

```
// Todo 277 (counselors codex #2 and opus #3 independently). Four sites stamp a
// window for a project, and each was an unguarded read-then-create: two
// concurrent creators both see no window for the project and both create and
// stamp one. findProjectWindow uses .find(), so the lower-index window wins
// FOREVER - the lead attaches to one tab, parentless splits land in the other,
// and nothing detects or reconciles it. It is durable, silent and permanent.
//
// THIS TEST MUST BE CONCURRENT AND IT MUST BE REAL. A fixture that spawns one
// worker, waits, then spawns another passes whether or not the fix works: the
// first call has already stamped a window by the time the second one looks,
// which is the sequential shape that let this ship in the first place. Two
// separate MCP SERVER PROCESSES are used rather than two calls on one, for the
// same reason test/helpers.mjs's raceProcesses exists: two calls inside one
// process cannot interleave at all, since launchAgent is synchronous from its
// first statement to its last.
//
// Both servers are started and initialized BEFORE the race, so what is raced
// is the tool call itself and not node's startup. Pre-fix this fails on
// roughly every run; the numbers are on todo 277.
```

## line 60

```
// The session exists but has no window for this project, so both
// spawners below take the same read-then-create path: splitTargetWindow
// finds nothing (no parent, no stamp) and each creates the project's
// window itself. Created here rather than by a first spawn, which would
// stamp a window and remove the race this file exists to reproduce.
```

## line 73

```
// Fired without awaiting either one first: awaiting the first call to
// completion is exactly the sequential fixture this test refuses to be.
```

## line 114

```
// The detector, kept even though the race above is closed: the state is
// durable and silent, a store carried across this fix keeps whatever
// duplicates it already had, and a future stamping site that forgets the
// claim reintroduces it.
//
// Counted RELATIVE to a baseline run on this same machine, never against
// doctor's absolute exit code - a CI runner with no `claude` installed
// makes doctor correctly fail for an unrelated reason, and an absolute
// assertion inverts silently there (test/CLAUDE.md, and helpers.mjs's
// failureCount carries the same warning).
```

## line 132

```
// A second window stamped for the same project, by hand: the exact
// state two racing creators used to leave behind.
```
