# Attic: test/tool-registration.test.mjs

Comments removed from `test/tool-registration.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Issue #49. run() in src/result.ts is the ONLY guarded entry point for the
// tool layer: the design's whole argument against per-tool read/write checks
// is "a new tool inherits the guard for free" (see the issue thread and
// src/result.ts's own comment), which is true only for as long as every
// registered tool's handler actually routes through run(). Nothing else in
// the suite asserts that. This scans the source directly, so a tool added
// later that forgets run() - the exact failure mode the choke point was
// chosen to avoid - fails loudly here instead of silently reading stale
// state off an orphaned store forever.
```

## line 22

```
// One chunk per registered tool: from this registerTool( call up to
// (not including) the next one, or EOF. The handler and its run() call
// live inside this slice, whatever the tool's inputSchema contains.
```

## line 32

```
// A bare `run(`, not `.run(`: better-sqlite3's Statement.run() is an
// unrelated method used throughout this codebase and would otherwise
// inflate the count with something that is not our choke point.
```

## line 39

```
// The handler's own body must BE a call to run(), not a block that
// calls run() somewhere inside while doing other work around it:
// every handler in this codebase is `(args) => run(...)`, not
// `(args) => { ...; return run(...); }`.
```

## line 53

```
// The blunt version of the per-file checks above, and the number named
// in the PR: 37 tools, 37 run() calls, verified per file rather than by
// this global count alone (two offsetting mistakes could satisfy a bare
// total). Fails if a future tool file is added and never wired into this
// test's directory scan.
```
