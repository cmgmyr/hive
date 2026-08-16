# Attic: src/result.ts

Comments removed from `src/result.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 2

```
// Type-only: erased at compile time, so this does not reintroduce the
// eager-store-open problem the lazy `await import("./context.js")` below
// exists to avoid.
```

## line 16

```
// Issue #49. run() is the choke point every registered tool's handler routes
// through, verified per file, so it is the one place a guard covers new
// tools for free. Checked before fn() runs, for every call including reads:
// a read served off an orphaned inode is stale state reported as current,
// the same defect class this guard exists to catch, not a lesser one.
// Distinguishing reads from writes here would need a per-tool annotation,
// reintroducing the "someone adds a tool later and forgets" failure the
// choke point was chosen to avoid.
```

## line 29

```
// Shared with src/cli.ts's own resolveProject, which reaches the same
// resolveHomeProject fallback through effectiveProjectId and is not covered
// by this file's run() choke point (run() only wraps the MCP tool layer).
```

## line 42

```
// Imported lazily, not at module top level: result.ts is pulled in by
// modules (projectYml.ts) that must NOT open the store merely by being
// imported (see test/store-isolation.test.mjs, "naming a store is not
// opening one"). db.ts opens the database in its own module body, so a
// static import here would make importing result.js do the same. A real
// tool call already needs a live store to do anything, so deferring the
// import to here costs nothing a genuine call wasn't already going to pay.
```

## line 53

```
// Imported here, AFTER the guard above, not concurrently with db.js's own
// import: context.ts opens the store the same way db.js does (see the
// comment above), so starting its module load before storeReplaced() has
// had a chance to refuse would run that load ahead of the exact guard it
// exists to respect. Nothing pins that context.ts's module body stays that
// cheap. Overlapping the two imports was never worth that risk anyway:
// context.js is already in the module cache by the time a genuine tool
// call reaches here (every src/tools/*.ts file imports it statically), so
// this import() call never does real work, only resolves an
// already-cached entry - the only case where starting it early would have
// saved anything real is the one case it is not safe to run early in.
```

## line 93

```
// Terminal output and files both want exactly one trailing newline, and an
// empty string wants none: `hive pad` on an empty pad should print nothing,
// not a blank line.
```
