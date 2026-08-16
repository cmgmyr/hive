# Attic: test/lead-window-ownership.test.mjs

Comments removed from `test/lead-window-ownership.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 265 / plan-lane-3-tmux-topology. One store-scoped session, one window
// per project, found by the @hive-project-id ownership stamp rather than by
// window name (decisions/2026-08-05-tmux-topology-windows-not-sessions.md).
// This is the REAL entry point end to end: two real `hive lead` processes,
// not a helper cmdLead happens to call - lane 2's own lesson
// (dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md) is that a
// helper's parameters can be made to agree in every call a suite can produce,
// which proves nothing about the caller that matters.
```

## line 32

```
// Deliberately the SAME name for both. Only `path` is unique in the
// projects table; two real checkouts ("api" in two different orgs) can
// legitimately share a name. This is the case a name-based window lookup
// gets wrong and a stamp-based one does not - decisions/2026-08-05-tmux-
// topology-windows-not-sessions.md: "two projects sharing a name stops
// being a correctness problem and becomes a cosmetic one." A same-window
// name for A and B would still pass every assertion below by accident if
// this file used distinct names, since a name-based lookup would then
// happen to disambiguate correctly too - the collision is what makes
// mutation (1) (look up by name) provably fail.
```

## line 118

```
// Todo 266. stillThere's only ownership check is foundWindow's own
// derivation (see the comment at foundWindow's lookup, src/cli.ts): a
// pane cannot pass `list-panes -t foundWindow` membership while actually
// living in a different project's window. That is provable from
// foundWindow's own construction and adding a second, independent
// ownership clause at the stillThere site would be untestable - any test
// for it would have to reconstruct this same fact
// (dead-ends/2026-08-05-helper-whose-parameters-cannot-disagree.md's
// shape). So this test pins the OBSERVABLE property the derivation
// exists to protect, at the entry point where a real regression would
// actually show up, rather than a clause that cannot independently fail.
```

## line 133

```
// Constructs THE ACCEPTED RESIDUAL's shape directly: B's own row made
// to record a pane that is real, alive, and socket-matching, but
// living in project A's window - what a cross-upgrade stale row would
// look like if the old and new topologies happened to share a socket.
// Getting a live tmux server into this state through the ordinary
// `hive lead` path would need an actual topology upgrade to fake.
//
// Issue #157 (todo 352, counselors claude-opus-5). pane_pid copied
// alongside target/socket now too, not just the two - without it, B's
// row keeps naming B's OWN pane's pid, which disagrees with A's pane's
// real pid this row now points at, and the adopt check's new
// paneReissued() conjunct (src/cli.ts) short-circuits adopted to null
// on the pid mismatch alone, BEFORE adoptableWindow's ownership
// exclusion (src/tmux.ts) is ever reached. This test's whole claim is
// that exclusion refusing a foreign-owned window, so a fixture that
// never reaches it passes for an unrelated reason - test/CLAUDE.md
// shape 7, an assertion satisfied by two indistinguishable causes.
// Copying pane_pid too makes the row internally consistent (the pane
// it names is A's, so the pid it records must be A's pane's real pid),
// which is what a genuine cross-upgrade stale row would look like
// anyway - it never had two independent facts to disagree with each
// other in the first place.
```

## line 171

```
// STORE ROWS FIRST, before any window lookup. A broken foundWindow
// derivation can leave a project with no window to find at all
// (windowFor's own assertion would then fire), and that must not hide
// the more direct fact - whether B's row now points at A's pane - a
// fact the store carries regardless of whether any window lookup
// works. Reviewed 2026-08-05: an earlier version of this test computed
// windowA/windowB before this point and asserted on windows first, so
// a broken lookup threw a bare TypeError before ever reaching these
// two assertions - real under the mutation below, but an inference
// from the crash, not an observation of the adoption itself.
```
