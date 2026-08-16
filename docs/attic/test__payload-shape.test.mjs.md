# Attic: test/payload-shape.test.mjs

Comments removed from `test/payload-shape.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 14

```
// Issue #46, step 1. No store, no tmux, no network -- this file reads only
// the committed JSON fixtures and calls pure functions on them, so it needs
// none of test/CLAUDE.md's isolation machinery (isolateTmux, scratch dirs).
//
// The manifest is derived from the SAME six fixtures test/hook-replay.test.mjs
// replays, loaded fresh here rather than imported from that file: this
// module owns no shared state with it, by design (the plan pad's own scope
// line -- this lane does not touch that file).
```

## line 33

```
// Every mutation test below clones before mutating: corpus entries are
// shared across the whole file, and a test that mutated one in place would
// silently poison every later assertion that reads the same fixture.
```

## line 46

```
// Both Stop fixtures carry background_tasks (empty in one, populated in
// the other), so its presence is required even though its per-element
// shape is not.
```

## line 58

```
// UserPromptSubmit's fixtures never populate background_tasks or
// notification_type at all, so it must derive no enums whatsoever.
```

## line 71

```
// This alone does NOT prove the checker can fire -- a checkPayload that
// always returns [] would pass every one of these too. It only rules out
// false positives; the mutation tests below are what prove detection.
```
