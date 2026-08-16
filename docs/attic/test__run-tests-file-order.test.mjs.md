# Attic: test/run-tests-file-order.test.mjs

Comments removed from `test/run-tests-file-order.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 423. scripts/run-tests.mjs hoists its longest file to the front of the
// schedule by spelling THAT file's path absolute while every other file
// stays "test/...", because node --test sorts its file list by path STRING
// before scheduling and "/" < "t" means an absolute spelling always sorts
// first. That's an implementation detail of node's own test runner, not a
// documented contract - see the comment above LONGEST_FILE_HOIST in
// scripts/run-tests.mjs. This pins the assumption directly, so a future node
// upgrade that changes it fails HERE instead of the suite quietly getting
// slower again with nothing going red.
//
// The fixture is built to rule out the other two plausible orderings, not
// just to demonstrate the intended one: the absolute-pathed file is given
// SECOND on argv (so argv order alone would run the other file first) and
// sorts AFTER it by name alone (so a plain alphabetical-by-name sort would
// also run the other file first). Only "an absolute spelling sorts before a
// relative one" puts it first, so a pass here is specific to the mechanism
// the hoist actually relies on.
```

## line 53

```
// Strip NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID: this file itself runs
// under node --test, which sets them, and a nested `node --test` that
// inherits them behaves as a coverage-collection child rather than a
// normal top-level run - it exits 0 having never executed the fixtures'
// top-level code, which reads as "test passed" while proving nothing.
// The production hoist never hits this: scripts/run-tests.mjs's child is
// spawned from a plain `node scripts/run-tests.mjs`, never from inside
// another node --test.
```
