# Attic: test/store-entry-guard.test.mjs

Comments removed from `test/store-entry-guard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Todo 324. test/store-isolation.test.mjs pins the two structural guards that
// keep a TEST RUNNER off ~/.hive; this file pins the guard those two cannot
// see, because it exists for a process that is neither: a hand-rolled step-11
// driver, run as a plain `node driver.mjs` with no NODE_TEST_CONTEXT at all.
// assertScratchStore() answers a different question again -- it is an OPT-IN
// self-check a destructive test file calls to confirm its own isolation
// worked, from the inside. This guard is involuntary and structural: it fires
// on any process reaching the default store, whether or not that process ever
// thought to call assertScratchStore().
//
// The incident, verbatim from the todo: a driver script set HIVE_DATA_DIR in
// the env it handed a CHILD server, then imported dist/db.js in ITSELF to
// seed a row a scratch store starts without. Handing the child its env is the
// obvious half; the parent's own import choosing ~/.hive is the half that
// bites. It changed nothing only because no live agent was named "impl".
```

## line 27

```
// A fresh, minimal-environment process, deliberately not helpers.mjs's own
// spawn helper: that helper's baseEnv() strips HIVE_* but keeps everything
// else, including NODE_TEST_CONTEXT, and the entire subject here is a driver
// that carries neither. Mirrors test/store-isolation.test.mjs's own pair of
// local helpers with the same shape; not hoisted into helpers.mjs because
// this is the only file that needs an entry point with NO ambient
// test-runner signal at all.
```

## line 55

```
// The incident's precise shape: HIVE_DATA_DIR lives only in an env
// object meant for a CHILD server, never assigned to this process's own
// process.env. This process's own db.js import still sees no
// HIVE_DATA_DIR and defaults to ~/.hive -- the half that bites.
```

## line 67

```
// Pins the RIGHT reason. No NODE_TEST_CONTEXT was ever set here, so a
// pass could only mean this hit the OLD (test-runner) refusal by
// accident -- exactly the false green test/CLAUDE.md warns against.
// Only the not-product-entry wording names the escape hatch.
```

## line 82

```
// Same reasoning as store-isolation.test.mjs's identical assertion:
// db.ts commits to a store during an import, so the refusal has to be
// printed and exited, not thrown out of a module body.
```

## line 91

```
// storeDir() only resolves and validates a path -- it opens nothing -- which
// is what makes it safe to prove these two cases against the REAL default
// store rather than a stand-in. db.js is deliberately never combined with
// HIVE_ALLOW_DEFAULT_STORE=1 anywhere in this file: proving the override
// also lets db.js proceed would mean actually opening ~/.hive/hive.db on
// whatever machine runs this suite.
```

## line 109

```
// The order inside defaultStoreRefusal() (src/dataDir.ts) is load-bearing:
// a test runner is refused outright, before the override is ever
// consulted. Checked here at the storeDir() layer rather than by
// importing db.js, so even a latent ordering bug could not reach the
// real store from this test.
```

## line 157

```
// The deliberate improvement over a basename check, pinned so a future
// simplification back to one fails here instead of shipping quietly: a
// same-named file OUTSIDE dist/ must not pass.
```
