# Attic: test/transcript.test.mjs

Comments removed from `test/transcript.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 11

```
// Every test below sets CLAUDE_CONFIG_DIR explicitly to the scratch dir, so
// none of it depends on (or can pollute) whatever ~/.claude actually holds.
```

## line 18

```
// Pinned against real directories on a real machine (issue #5, todo 88),
// not derived from the issue's prose. A test that only checked "is this
// non-null" would pass equally for a resolver that encodes nothing
// correctly, since a missing directory and a broken encoding both produce
// null -- so this asserts the exact VALUE, with no filesystem involved.
```

## line 51

```
// Existence gating tested against a directory this test controls, kept
// deliberately separate from the encoding tests above: this is the half
// that a naive "assert not null" test would have conflated with a broken
// encoding.
```
