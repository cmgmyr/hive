# Attic: test/lead-restart-gaps.test.mjs

Comments removed from `test/lead-restart-gaps.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Lane A step 2 (plan-lane-a-cmdlead-characterisation, pad 73). The audit
// posted on todo 258 found three gaps in the existing suite's coverage of
// cmdLead's restart path (src/cli.ts):
//   - behaviour 1's "claims the session's own INITIAL window, no stray
//     shell window left over" half (the pane-id-recorded half is already
//     pinned by test/lead-pane-target.test.mjs and test/lead-identity.test.mjs);
//   - behaviour 2 in full: a restart with the lead's own pane still
//     genuinely alive reuses that SAME pane rather than creating a second;
//   - behaviour 4 in full: unknown liveness (a foreign tmux_socket on the
//     row) is treated as "not still there", so `hive lead` proceeds with a
//     fresh pane rather than refusing or - the actual defect this pins
//     against - silently reusing a pane on a server this process cannot see.
// Behaviours 3, 5 and 6 are already pinned elsewhere (test/lead-pane-target
// .test.mjs and test/lead-identity.test.mjs STEP 1c/1b) and are out of scope.
```

## line 53

```
// -s, not -a: test/CLAUDE.md forbids list-panes -a (it ignores -t and reads
// the whole server). -s -t =<session> is the scoped way to see every pane
// across every window of ONE session.
```

## line 92

```
// Fires ONLY when BEHAVIOUR 1's wait for the launch marker times out -
// costs nothing on the passing path, and this test has already burned two
// ubuntu CI round-trips (~4 minutes each) on the same failure guessed at
// twice. Every item here is something the failing run could not otherwise
// answer: whether the fake dir actually reached the tmux SERVER's PATH
// (not just this test process's own), what tmux was ASKED to run versus
// what it reports running now, the pane's own rendered output (a lookup
// failure puts "command not found" right there), and the fake claude
// script's permissions and shebang - a Node writeFileSync mode and Linux's
// exec bit are not the same question as macOS's.
```

## line 131

```
// Shared by BEHAVIOUR 4/5/6 below: each manufactures one bad fact onto an
// otherwise-ordinary lead row (a foreign socket, a mismatched pid, an empty
// pid) after a real first `hive lead` boot, then re-runs `hive lead` and
// asserts on what THAT run did. This is the boot half only, identical across
// all three until /simplify flagged the duplication this lane's own two new
// tests added on top of BEHAVIOUR 4's pre-existing copy; what gets
// manufactured and what the second run is expected to do stays in each test.
```

## line 168

```
// A launch marker, not `pane_current_command`, proves the lead
// command actually ran. `pane_current_command` is a SAMPLE of what
// tmux reports as the pane's foreground process right now, derived
// differently on macOS and Linux - and the fake claude here runs
// `sleep 600` as a CHILD of the wrapper's own `sh -c`, not via `exec`
// (see makeFakeClaude, test/helpers.mjs), so the two platforms can
// legitimately disagree about which process in that chain counts as
// "current". This project already has a rule for exactly this shape
// (test/CLAUDE.md, "assert against a RECORD, never a SAMPLE") -
// matches test/lead-data-dir.test.mjs's own marker-file arrangement
// rather than inventing a new one. Do NOT "fix" this by adding `exec`
// to the fake claude to make `pane_current_command` read "sleep" -
// that only makes the fixture conform to a platform-dependent probe,
// leaving the same trap for the next reader; `exec` here (below) is
// used for its own reason (no zombie shell), independent of any probe.
```

## line 196

```
// A tmux SERVER with no sessions left exits, and the next one to start
// renumbers windows from @0 - measured directly: an earlier version of
// this test killed only the probe session, got window id 0 back for
// both the probe and the lead, and the assertion below could not tell
// "claimed the initial window" from "got a fresh server". A second,
// unrelated session kept alive for the probe's duration keeps the
// server (and its window-id counter) alive across the probe's own
// kill-session, the same way STEP 1c's own comments describe.
// The keepalive is the first tmux command in this test, so it is what
// STARTS the server - and tmux copies its own process environment into
// the server's global environment at that moment, once, for the
// server's whole lifetime. A later session (this test's real one,
// opened from the CLI child below) only overrides the specific
// variables `update-environment` names, which excludes PATH by
// default; PATH for every session on this server, including the CLI
// child's own, is answered from THIS call's env, not the creating
// client's. Measured on ubuntu CI (run 31013486469): without this, the
// lead's respawn-pane runs a `claude` neither the server nor the fake
// dir on this test process's own PATH can resolve, so
// BEHAVIOUR 1 timed out waiting for a pane that never ran it - passed
// on macOS only because of a platform default this project does not
// control, exactly the shape F1 exists to remove. Setting PATH here
// fixes it BY CONSTRUCTION rather than by inheritance: it does not
// depend on whichever process happens to create the server first,
// since this call always is.
```

## line 226

```
// Declared here, not inside the try, so the finally below can clean it
// up even if it is never assigned - a throw between this line and the
// probe's own kill-session (windowIdOf, line ~159, is real tmux I/O
// and can throw) must not leave the probe session orphaned.
```

## line 232

```
// Window ids (@N) are allocated once, monotonically, per tmux
// SERVER - never reused, never per-session (measured against a
// throwaway tmux server before writing this: killing a window and
// making a new one in the same session skips straight to the next
// global id, and a second session on the same server continues the
// same counter). Probing with a throwaway session pins "the next id
// this server will ever hand out" BEFORE `hive lead` runs, which is
// the only way to know what "the session's own initial window"
// should be without a session already existing to inspect it - a
// fresh session not existing yet is the whole premise of this case.
```

## line 243

```
// ":" suffix, not a bare "=<session>": measured directly against a
// throwaway tmux server that display-message -p's own format
// substitution comes back EMPTY (exit 0, not an error) for an
// exact-match session target with no window/pane part - list-panes,
// list-windows and capture-pane all accept the bare form fine, but
// this one format-printing path does not. A trailing colon keeps
// the exact-match semantics and gets a real answer back.
```

## line 259

```
// THE MUTATION THIS FAILS AGAINST: dropping claimInitialWindow's
// window claim so the fresh-session branch creates its own
// new-window instead of respawning into the session's own initial
// one (pad 73's mutation 1). `new-session` always allocates one
// window id for the session's default shell before hive gets a say;
// a second `new-window` call consumes a SECOND id. A plain
// window-count check cannot tell "claimed the initial window" apart
// from "made a second window and killed the first", because both
// end up with exactly one window in the end - the id, allocated in
// creation order and never reused, is the one thing that still
// tells them apart afterwards.
```

## line 277

```
// The behaviour's other half, asserted directly rather than only
// inferred from the id: exactly one window in the session, exactly
// one pane in it, and that pane actually ran leadCommand rather
// than sitting idle as an unclaimed default shell.
```

## line 300

```
// probeSession is normally already killed above (line ~160); listed
// again here so a throw before that kill-session runs (e.g.
// windowIdOf) does not leave it orphaned. cleanup() no-ops on an
// already-gone session.
```

## line 313

```
// A RECORD of every launch, not a final-state sample: the row and the
// pane list after both runs only show what tmux/the DB look like NOW,
// and a rewrite that split a fresh pane, launched a second claude,
// then noticed the original was still alive and killed its own split
// would leave both looking identical to "reused the same pane" -
// passing this test's other assertions while still violating "creates
// no second one". Each claude launch appends its own line here, so a
// create-then-kill still leaves the evidence a final snapshot cannot.
```

## line 344

```
// Nothing is killed or altered in between - the plain idempotent
// case, which nothing in the existing suite drives twice in a row
// without perturbing the row or the pane first.
```

## line 354

```
// THE ASSERTION THIS BEHAVIOUR IS: what did NOT happen. Same pane
// id, not merely "a live pane exists".
```

## line 361

```
// THE MUTATION THIS FAILS AGAINST: forcing the found-window branch
// to always split a fresh pane, skipping the `if (stillThere)` reuse
// entirely (not one of pad 73's five - those target behaviours
// 1/3/4/5, and none of them changes what happens when the pane is
// genuinely alive: mutation 2 only matters for a DEAD previousTarget,
// and mutation 3 only matters for UNKNOWN liveness). Skipping the
// reuse branch outright makes `after.tmux_target` differ from `pane`
// and leaves two panes in the window - both assertions above go red.
```

## line 374

```
// runCli resolves once the CLI CHILD exits, not once the pane it
// told tmux to respawn/split has actually run its shell - `hive
// lead` hands tmux a command and returns; the fake claude's `echo
// ... && exec sleep 600` runs asynchronously in the pane afterward.
// Reading the log immediately races that write. Waiting for the
// recorded pane to actually reach "sleep" (the same signal BEHAVIOUR
// 1 waits on) means its `echo` already ran, since `exec` replacing
// the shell with sleep cannot happen before the `&&` before it does.
```

## line 388

```
// THE ASSERTION THE FINAL-STATE CHECKS ABOVE CANNOT MAKE: exactly
// one claude process was ever launched across both `hive lead`
// calls, not merely that exactly one is running now. THE MUTATION
// THIS FAILS AGAINST: mutation 6 (skip the `if (stillThere)` reuse,
// always split fresh) now also fails HERE even in a hypothetical
// rewrite that cleaned up its own extra pane afterward - the launch
// log has two lines the moment a second `hive lead` call ever starts
// a second claude, regardless of what the row or pane list look
// like by the time this test reads them.
```

## line 415

```
// Manufacture the unknown case by writing a foreign recorded socket
// onto the row - previousSocket's own source (ensureLeadRow's
// `existing.tmux_socket`), read straight off the row rather than
// derived - NOT by tearing down tmux. The pane stays genuinely
// alive, on this same real isolated server; only the DATABASE'S
// claim about which socket it lives on is now wrong.
// foreignSocket() (src/tmux.ts) treats any non-empty, non-matching
// value as "this row's last-known pane belongs to a server this
// process cannot honestly judge", and rowLive() folds that into
// null rather than true or false.
```

## line 434

```
// THE MUTATION THIS FAILS AGAINST: dropping the
// `rowLive(previousSocket, previousTarget) === true` conjunct from
// stillThere's expression ENTIRELY (pad 73's mutation 3 - "ignore
// rowLive"), not just the `=== true` comparison. Verified directly:
// trimming only the `=== true` and leaving bare
// `rowLive(previousSocket, previousTarget)` in the && chain is a
// NO-OP, because Liveness is `boolean | null` and both `null` and
// `false` already coerce falsy in a boolean context, exactly like
// `true`/`false` do against `=== true`. So `=== true` is
// documentation of the deliberate "unknown reads as not still
// there" bias, not what enforces it - falsiness does the actual
// work, and enforces it just as well for a `Liveness` return of
// `boolean | null` as it would with the comparison removed. Worth
// knowing before lane 3 touches this: a future `rowLive` returning
// some OTHER falsy-looking value that is not `false`/`null` (a
// string, an object) would flip the bias silently with `=== true`
// still sitting there looking like a guard. Dropping the whole
// conjunct is the mutation that actually removes the check: without
// it, stillThere only asks whether previousTarget is a pane id
// still listed in the found window, which is true here (the pane
// is genuinely alive) - so the mutated code would wrongly REUSE the
// original pane despite the foreign socket, exactly the "hive
// types into a stranger's pane" class of bug this behaviour's own
// deliberate bias exists to avoid.
```

## line 461

```
// Proceeding, not refusing, is the documented bias: the original
// pane is left alive and untouched rather than killed or reclaimed.
```

## line 471

```
// The CAS heals tmux_socket back to this process's own real socket,
// not left naming the foreign one this test seeded.
```

## line 486

```
// Manufacture the mismatch by writing a pid the running server did
// not actually hand out onto the row - not by tearing down tmux. The
// pane, the socket and the window stamp all stay genuinely correct;
// only the DATABASE's claim about which process is in the pane is
// now wrong, which is the exact shape issue #157 describes: cmdAttach
// leaves a bare shell in the recorded pane and the row still names
// the old server's pid.
//
// Derived from the REAL pid rather than a fixed literal (counselors,
// codex-5.6-sol-high / claude-fable-5, both independently): a fixed
// "999999" is a real, assignable pid on a Linux host with a raised
// pid_max (default 4194304), so on such a host the fixture could
// coincidentally NOT mismatch and this test would wrongly go red
// against CORRECT code. before.pane_pid + 1 is guaranteed to differ
// from itself by construction, no matter what value tmux handed out.
```

## line 508

```
// THE MUTATION THIS FAILS AGAINST: the pre-fix adopt condition, which
// asks only isPaneTarget(previousTarget) && rowLive(...) === true and
// never compares pane_pid. Against that code this assertion goes red:
// the mismatched pid is never consulted, adoptableWindow finds the
// window by its stamp alone, and cmdLead adopts originalPane as-is -
// recording the SAME pane the fix below must instead treat as
// reissued and refuse to take back.
```

## line 518

```
// THE STRANGER'S PANE (plan-352-lead-adopt-pid): left running, not
// killed - it is not hive's pane to kill, and the found-window branch
// this falls through to already splits a fresh pane in beside
// whatever is there rather than replacing it.
```

## line 531

```
// The CAS records the fresh pane's real pid, not the manufactured one.
```

## line 546

```
// '' is pane_pid's own DEFAULT and "no fact recorded" reading
// (src/db.ts's migration, panePid's own comment) - every row written
// before todo 336's migration landed reads this way. #152's own
// fix-round finding (test/lead-pane-reissued.test.mjs) closed this
// gap for deliverable() and the janitor sweep; this is the third call
// site of the same idea (issue #157), so it needs the identical
// control.
```
