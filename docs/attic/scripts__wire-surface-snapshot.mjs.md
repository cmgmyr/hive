# Attic: scripts/wire-surface-snapshot.mjs

Comments removed from `scripts/wire-surface-snapshot.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Regenerates test/fixtures/wire-surface/tools-list.snapshot.json from a
// real, built server's tools/list response. Also the ONE place the
// snapshot's serialization is defined - test/wire-surface.test.mjs imports
// sortKeysDeep and renderToolsSnapshot from here rather than keeping its own
// copy. Counselors round 2, item 5: the test's message says "regenerate it
// deliberately" and previously gave no way to do that, so a hand-rolled
// regeneration would have had to reproduce sortKeysDeep + JSON.stringify(_,
// null, 2) + the trailing newline exactly. A near-miss there produces a
// whole-file diff that looks like a real wire-surface change (e.g. lane C's
// zod 4 bump) and is really just the writer disagreeing with the reader.
//
// Usage: node scripts/wire-surface-snapshot.mjs
```

## line 24

```
// Deterministic normalisation for the snapshot: sort OBJECT keys at every
// level, so lane C's reviewer gets a diff keyed by property name rather than
// one that reorders every tool because zod 4 changed emission order.
//
// Arrays are deliberately left UNSORTED, and that is a real, accepted
// residual - counselors round 2, item 3 caught an earlier version of this
// comment claiming the file was "stable regardless of declaration order,"
// which is false. `required` is emitted in the tool's zod shape declaration
// order (src/tools/*.ts), so a pure no-op reorder of two fields in one
// tool's inputSchema - a refactor a client cannot observe - fails the test
// that imports this function. That trade is kept anyway: sorting `required`
// would mean sorting arrays generally, and `enum` order (and any future
// positional construct, like a tuple's `prefixItems`) IS genuinely
// client-visible - a model reads `enum` in the order it is presented.
// Keyword-aware sorting (sort `required`, leave `enum` alone) was
// considered and rejected: it is cleverness this lane does not need, and an
// occasional false failure on a `required` reorder is a cheap price next to
// silently losing a real `enum` reorder.
```

## line 50

```
// tools/list's `tools` array -> the canonical snapshot object, keyed by
// name (minus `name` itself, redundant with the key). The WHOLE tool
// object, not just inputSchema - counselors round 2, item 4, the biggest
// gap in an earlier version of this lane. tools/list also returns
// description, execution, and (when present) title, annotations, and
// outputSchema; none of that was pinned before, so an SDK bump that changed
// how descriptions or annotations are emitted would have passed untouched.
// description is the more behaviourally load-bearing half of the wire
// surface - it is what steers the model - so an inputSchema-only snapshot
// was checking the less important half.
```

## line 64

```
// The exact bytes that belong on disk: pretty-printed, trailing newline.
// test/wire-surface.test.mjs's byte-exact backstop assertion compares
// against exactly this.
```

## line 71

```
// Spawns the BUILT server (dist/index.js, not src/) over real stdio and
// returns its tools/list result - `npm run build` first is the caller's
// job, the same precondition every other script here has.
```

## line 81

```
// Same StringDecoder reason as test/helpers.mjs's McpClient, and it
// matters MORE here: this is the process that WRITES the fixture, so a
// multibyte sequence split across two `data` events would be decoded as
// two U+FFFD halves and committed as the new expected value. No tool
// description contains non-ASCII today, which makes this latent rather
// than live - but descriptions are prose, and the day one gains an
// accented character is not the day to discover this.
```
