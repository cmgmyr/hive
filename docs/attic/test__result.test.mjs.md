# Attic: test/result.test.mjs

Comments removed from `test/result.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Issue #49. run() in src/result.ts is the choke point every registered
// tool's handler routes through. Once storeReplaced() (src/db.ts) is
// tripped, run() must refuse EVERY call, including reads, before fn() ever
// runs, and say why.
```

## line 14

```
// Control. Without this, the refusal below could be satisfied by a run()
// that refuses everything unconditionally.
```

## line 56

```
// The design decision from the issue thread: run() does not distinguish
// reads from writes. A read served off an orphaned inode is stale state
// reported as current, which is the defect this guard exists to catch.
```

## line 69

```
// No writes here at all: a plain read-only closure, e.g. what
// whoami's handler looks like.
```
