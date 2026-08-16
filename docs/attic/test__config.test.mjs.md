# Attic: test/config.test.mjs

Comments removed from `test/config.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// config.ts reads storeDir() at call time (same reasoning as dataDir.ts
// itself), so setting HIVE_DATA_DIR before each case, rather than importing a
// fresh process per case, is enough: nothing here is cached at module load.
```

## line 112

```
// storeDir() refuses the real store outright when a test runner is the
// entry point (.claude/rules/store-and-datadir.md). Folding that into the
// same catch as "no config.json yet" would make a test process that forgot
// to set HIVE_DATA_DIR read a silent "auto" instead of the loud failure
// the guard exists to give it. NODE_TEST_CONTEXT is already set by
// node:test itself; only HIVE_DATA_DIR needs removing. HIVE_ATTACH_MODE
// is cleared too: the env override short-circuits before storeDir() is
// ever called, so a stray value from the ambient shell would silently
// skip the refusal this case exists to pin.
```
