# Attic: test/hook-replay.test.mjs

Comments removed from `test/hook-replay.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Issue #32, half E. #24 was not a logic bug: stateFor's branches were
// probably correct for every payload the #24 lane had tried, and Claude Code
// sent one it did not have. This corpus does not fix that gap and cannot: it
// replays payloads Claude Code has ALREADY been observed sending, through the
// BUILT dist/hook.js, against a scratch store, and asserts the state it
// decides. A payload of a shape Claude Code has not yet been observed sending
// is not in here, by construction, so a next-version change to hook shapes
// gets past this suite exactly the way it got past #24's. Half D (a canary
// running a real claude against an isolated store, diffing observed shapes
// against a committed corpus) is what closes that gap; this is a net under
// it, never a substitute. See test/fixtures/hook-payloads/README.md for what
// is and is not covered, and why.
//
// Every fixture here was read out of agent_state_log on the live store,
// read-only, and copied byte-for-byte; none were hand-written from docs.
```

## line 64

```
// The row stateFor decides, mirrored into agent_state_log verbatim except for
// its one non-value: a null decision (the notify/idle_prompt branch) logs as
// "unchanged" rather than a state agent_state can hold, and leaves the row at
// whatever it already was. That is the only row where "already was" matters:
// every other branch overwrites unconditionally, so a wrong starting value
// there would still pass. Deriving agent_state from it, rather than listing
// both, keeps the two from being able to disagree.
```

## line 75

```
// [fixture file, hook event argv, starting agent_state]. Starting state is
// inert everywhere except notify-idle-prompt, where it is "working"
// specifically so a regression that started writing idle there would be
// caught rather than mistaken for the value the row already had.
```

## line 81

```
// This fixture used to carry a special meaning - hive's own spawn
// announcement, which src/hook.ts excepted from clearing the first-prompt
// latch (todo 373). Todo 387 deleted that exception along with the turn
// that created it, so this fixture is now just "a prompt payload" like the
// one above: its STATE decision is the same as any other prompt, which is
// the point of keeping it in this table rather than the reason.
```

## line 96

```
// No per-case reset: each row uses a distinct fixture file as its actor id
// and gets its own agents row, so rows never collide and nothing another
// case wrote is ever in scope for this one's assertions.
```
