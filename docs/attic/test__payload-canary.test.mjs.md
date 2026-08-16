# Attic: test/payload-canary.test.mjs

Comments removed from `test/payload-canary.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// analyzeRows and evaluateRun are the two pure functions this lane's live
// wiring script (scripts/payload-canary.mjs) uses to decide, and report,
// whether a run passed. Both were exported and untouched by `npm test`
// until this file: exactly the "checker that cannot fire" shape
// test/payload-shape.test.mjs's own header warns about, one directory over.
// No isolateTmux() here: plain data in, plain data out, same as
// test/part-c-assert.test.mjs one door over for the same reason.
```

## line 15

```
// A tiny synthetic corpus, not the real one: these tests are pinning
// analyzeRows' OWN aggregation (stopCount, anyStopWithBackgroundTasks,
// parseFailures, findings roll-up), not payload-shape.mjs's derivation,
// which test/payload-shape.test.mjs already owns against the real corpus.
```

## line 68

```
// Missing background_tasks entirely: required in the synthetic
// manifest above (present, if sometimes empty, in both Stop fixtures).
```

## line 77

```
// The row's own `event` column is "stop" (src/hook.ts's CLI arg), which
// is not a key the manifest has. If analyzeRows ever used row.event
// instead of payload.hook_event_name, this well-formed Stop row would
// get an "unknown_event" INFO instead of being checked for real.
```

## line 90

```
// A fully conformant, fully VALID run: identical git snapshots, a fired
// (not cancelled) wake, the branch's own hive-iso server confirmed, at
// least one subagent demonstrably ran, and a clean analysis. Each test
// below mutates ONE field off this baseline.
```

## line 137

```
// would independently be INCONCLUSIVE
```

## line 167

```
// THE TWO TESTS THAT MATTER MOST (lead review after run 2): a lazy worker
// and a real #24 regression must never produce the same verdict, even
// though both leave background_tasks empty. The only thing that tells
// them apart is whether a subagent demonstrably ran.
```

## line 174

```
// run 2's own observed shape: step 0 never ran either
```
