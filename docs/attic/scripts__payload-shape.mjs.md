# Attic: scripts/payload-shape.mjs

Comments removed from `scripts/payload-shape.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Issue #46, step 1: the pure payload-SHAPE conformance module. Diffs an
// observed Claude Code hook payload against a manifest derived, at runtime,
// from the committed corpus (test/fixtures/hook-payloads/). No second
// committed shapes file: the corpus itself is the manifest's only source.
//
// SHAPE ONLY. Nothing here decides or asserts what state hive writes for a
// payload (idle/working/waiting, stateFor, waitingOnSubagents); that surface
// belongs to test/hook-replay.test.mjs.
//
// Everything below loadCorpusFromDir() is a pure function: plain objects in,
// plain findings out, no I/O. loadCorpusFromDir() is the one exception,
// isolated so callers (this file's tests, and the live canary script) can
// build a manifest from real fixtures without the decision logic itself
// touching a filesystem.
```

## line 20

```
// The discriminating fields issue #46 names by name: the ones whose VALUE,
// not just presence, distinguishes one payload shape from another already
// seen. Array-valued fields are addressed with a trailing "[]", matching
// collectFieldPaths' own flattening below.
```

## line 32

```
// Every array element shares the SAME path ("background_tasks[]", not
// "background_tasks[0]"): a hook payload's arrays are unindexed collections
// of like-shaped entries, not fixed-position tuples, so per-index paths
// would fragment one field into as many paths as the corpus happens to have
// elements for, and required/known derivation below would never converge.
```

## line 46

```
// One walk per payload, not one per caller: deriveManifest and checkPayload
// both need a path's types (for known/required) AND its raw values (for
// DISCRIMINATOR_PATHS' enums), and re-walking the same tree once per
// discriminator to re-derive values a single pass already saw was pure
// waste. Every path's entry keeps both, so no caller pays for a second walk.
```

## line 66

```
// records: [{ event, payload }, ...]. Per event: KNOWN is the union of field
// paths seen; REQUIRED is the intersection, so a field present in some
// fixtures of an event and not others is optional BY CONSTRUCTION -- the
// honest reading of a small, real corpus, not a hand-picked schema. ENUMS
// covers only DISCRIMINATOR_PATHS, and only where the corpus actually
// produced a value for that (event, path) pair.
```

## line 92

```
// Intersect in place: seed from the first payload's paths, then drop
// anything later payloads don't also have. A field present in some
// fixtures of this event and not others is optional BY CONSTRUCTION --
// the honest reading of a small, real corpus, not a hand-picked schema.
```

## line 115

```
// Findings, most-severe first is NOT guaranteed by this function's own
// ordering (missing-required, then per-path type/new-field, then enums) --
// callers that care about severity order filter on `severity` themselves.
```

## line 196

```
// The one I/O function in this file. event comes from the payload's own
// hook_event_name, never the filename, so a fixture named after what it
// demonstrates does not silently mislabel its event.
```
