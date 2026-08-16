# Attic: test/pad-append-live-separator.test.mjs

Comments removed from `test/pad-append-live-separator.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Fix round 1 on todo 345 / issue #148, P1: both counselor seats
// independently found that pad_append's separator was decided in JS from
// `pad.content` AS READ (a `joined` variable), not from the live column -
// so while the append's own concatenation was safe against a concurrent
// change, the SEPARATOR was not. Two sessions both reading content that
// ends in a newline both decide joined = "", and whichever writes second
// glues its entry onto the first's with none: content "alpha\n", A reads
// it, B appends "B-entry" first (content now "alpha\nB-entry", no trailing
// newline), then A's write runs with its own already-decided joined = "",
// producing "alpha\nB-entryA-entry".
//
// The fix (APPEND_WITH_SEPARATOR_SET, src/tools/pads.ts) moves the decision
// into the same UPDATE statement as a CASE over the live `content` column,
// so there is no read-then-decide step left to go stale - matching the
// property pad_append's own concatenation already had. That means there is
// no race window left to reconstruct the way the revision and lease races
// were: nothing in JS reads content before this statement runs at all, so
// the test below proves the property directly - the separator always
// reflects whatever content the row ACTUALLY holds at write time, never
// what an earlier read believed - rather than raced or interleaved.
//
// PROVEN RED against the pre-fix `joined`-in-JS shape: a throwaway repro
// reproducing the exact scenario above (readByA taken once, B's append
// landing before A's, A's write using its stale separator) produced
// "alpha\nB-entryA-entry" - B's and A's entries glued with no separator.
// Output pasted in the PR body.
```

## line 45

```
// Starts with no trailing newline, matching pad_append's own JSDoc
// scenario in reverse (missing separator becomes a spurious blank line
// the other direction) - this direction is the glued-entries case.
```

## line 50

```
// B's append: content "alpha" has no trailing newline, so this adds one.
```

## line 54

```
// A's append never reads content at all - there is nothing in JS left to
// go stale. The CASE in the same statement sees content as it actually
// is right now ("alpha\nB-entry", no trailing newline) and separates
// correctly regardless of what content looked like at any earlier point.
```
