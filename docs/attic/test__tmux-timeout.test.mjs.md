# Attic: test/tmux-timeout.test.mjs

Comments removed from `test/tmux-timeout.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 20

```
// Todo 375. tmux() had no timeout, so one wedged tmux server could hang a
// caller forever at 100% CPU (measured: 1h34m of a burning core). Bounding it
// is the easy half. THE HALF THAT DECIDES WHETHER THE FIX IS GOOD OR HARMFUL
// is what a timed-out call MEANS: every liveness path in this project rests on
// `false` (tmux answered, the target is not there) versus `null` (tmux never
// answered), and a timeout read as `false` reaps live workers - the exact
// failure the bound exists to prevent, arriving through the fix for it.
//
// So these tests pin the CLASSIFICATION, not the number.
```

## line 39

```
// A `tmux` that never answers, which is what a wedged server looks like from
// here (fakeHangingTmux, test/helpers.mjs, carries the `exec sleep` reasoning).
```

## line 42

```
// Somewhere for the call-counting fake below to write its log. Its own
// directory rather than the fake's, so removing the fake cannot take the
// evidence with it.
```

## line 51

```
// assert.throws() returns nothing, and every assertion here is about the
// error's own fields, so the error itself has to be caught rather than
// matched.
```

## line 63

```
// PATH is restored in a finally, and that is load-bearing rather than tidy:
// isolateTmux()'s own exit handler shells out to the REAL tmux to kill this
// file's server, and a fake left on PATH would make that handler wait out its
// own 5s bound and then leave a live server behind.
//
// HIVE_TMUX_TIMEOUT_MS (testing only, and `hive doctor` reports it when set)
// is what keeps this file fast: the production bound is ten seconds, and it
// can only expire in real time.
```

## line 76

```
// The stderr fixture is a real tmux wording from NOTHING_THERE's own list.
```

## line 79

```
// CONTROL FIRST, and it is what makes the assertion below able to fail.
// Without it, "a timeout does not read as absence" would pass just as
// happily against a fixture whose text never matched anything - the
// assertion-satisfied-by-two-indistinguishable-causes shape in
// test/CLAUDE.md. This proves the text genuinely IS classified as absence
// when it arrives on an ordinary TmuxError.
```

## line 87

```
// THE HEADLINE. Same text, killed call: never answered is not an answer.
// Red against the pre-fix behaviour, where this error would have been a
// plain TmuxError carrying that stderr and classified as "gone".
```

## line 105

```
// The bound is a bound: this returns rather than hanging, which is the
// whole defect. Generous ceiling - what would fail here is not being
// slow, it is never coming back at all.
```

## line 116

```
// false here is what closes a live worker's row, ends a lane mid-turn,
// and cancels its pending wakes. null holds everything instead.
```

## line 125

```
// COUNSELORS ROUND 2, F2, AND THE COMMENT THIS REPLACES DESCRIBED THE
// BEHAVIOUR THE LANE REMOVED. It said quietTmux answers false on a
// timeout and falls through to new-session - the pre-/simplify
// flattening - and the assertion below it could not tell the two apart:
// new-session times out too, throwing the SAME TYPE inside the SAME
// bound, so deleting quietTmux's rethrow kept the whole suite green while
// freeViewSessionName went back to reading every candidate name as FREE
// against a wedged server. test/CLAUDE.md's shape 7, in the headline file
// of the lane that cites that catalogue.
//
// So this counts the PROBE. With the rethrow, has-session throws and
// new-session is never reached; without it, both are called. The call log
// is the only thing that differs.
//
// TODO 404: the fake's own process creation can lose the race against the
// 300ms SIGKILL under the run's own concurrency, before the shim ever
// reaches its first line - true regardless of what that first line is, so
// reordering the shim's write earlier (already the case; see
// fakeHangingTmux's `record`) cannot close it, and widening this bound
// only buys headroom against a contender (the suite's own file count)
// that keeps growing. A bounded retry does not have either problem: each
// attempt is an independent scheduling opportunity, so it stays effective
// regardless of suite size. Only the RACED read - the log never got
// written at all - is retried; a log that captured the wrong calls is a
// real regression and fails immediately, on the first attempt it appears.
//
// SCOPE CORRECTION (todo 404, instrument pass). 1b14a0a's message says the
// retry "provably does not survive a correlated burst where every
// competitor races the same assertion at once (measured: still failed ...
// under a synthetic 40-way xargs -P 40 burst, with or without the retry)"
// and that "that regime is not what the retry is claimed to help with."
// MEASURED, by that same commit: the 40-way single-parent burst above,
// and a 25-way/bursty-40-way SEPARATE-PROCESS background load that
// reproduced zero failures in 20 trials with no retry needed. NOT
// MEASURED: a post-merge instance on a tree carrying this mitigation
// (comment 1032/1034 on todo 404) hit this test's ENOENT signature once
// under a plain 7-file parallel `node --test` run - closer to "several
// ordinary competitors" than to the synthetic 40-way shape - but the run
// kept no failure text, this test has four assertion sites and only this
// one is retried, and three immediate reruns of the identical shape never
// reproduced it again (206/206 each, one attempt every time per the
// logged duration). So whether an ordinary multi-file run already sits in
// the regime the retry does not cover is an open INFERENCE, not a
// measurement either way - 1b14a0a should not be read as having named the
// full boundary, only the one burst it tested.
```

## line 185

```
// Attempt count and per-attempt elapsed ms name the failure's own
// regime without another triage (todo 404): three attempts that
// each ran out the full bound is a correlated burst: this same
// scheduling problem hit every attempt, which is the shape the
// retry does not claim to survive. One attempt failing near-
// instantly, well under the bound, is something else - the retry
// itself never getting a fair scheduling shot.
```

## line 210

```
// PR gate, fix round 1, and the argument the lead overrode me with:
// doctor does not print "what it could see", it prints `sessions: none
// running` and `window stamps: no session` as green ok lines, which are
// ASSERTIONS and are false when tmux never answered. The scenario is this
// todo's own - the LIVE server wedges - and orphanScratchServers()
// excludes the live socket by design, so nothing else in the output would
// have said the server hive is talking to is unreachable.
//
// hangOn: "ls" rather than a blanket hang, so `tmux -V` (deliberately
// unbounded, answered client-side) still returns and the run reaches the
// read under test.
```

## line 231

```
// The claim that must NOT be made about a server that never answered.
```

## line 234

```
// CONTROL, on the same machine and the same store: with a tmux that
// answers, doctor says none of that. Without it, an assertion on a
// string doctor might never print in any world would pass just as well.
```

## line 246

```
// COUNSELORS ROUND 2, F3. Fix round 1 taught doctor to say unknown for a
// TIMEOUT, and wrote the predicate as `!(e instanceof TmuxTimeoutError)`,
// which covers the timeout SHAPE and leaves the unknown CLASS reading as
// an answer: EACCES spawning tmux, ENOBUFS, a transient socket error each
// printed `ok sessions: none running` again. The predicate is
// tmuxSaysNothingThere now, so it is true for what tmux actually
// answered and false for everything else.
//
// No timeout is involved here at all: the fake exits 1 immediately with
// text NOTHING_THERE does not match.
```

## line 267

```
// THE CONTROL THAT KEEPS THE PREDICATE FROM BEING "any failure at all":
// a tmux that ANSWERS "there is no server" is a genuine empty world and
// must still read as one, or doctor calls every machine with nothing
// running unknowable.
```

## line 289

```
// The one fact tmux()'s timeout branch rests on, pinned against the real
// node this suite runs on rather than assumed from documentation: a
// node upgrade that changed this shape would silently turn every timeout
// back into an ordinary TmuxError, and every assertion above would still
// pass because they construct their errors by hand.
```

## line 298

```
// An ordinary non-zero exit carries a status and no code at all, which is
// what keeps the branch from claiming ordinary failures as timeouts.
```
