# Attic: test/probe.test.mjs

Comments removed from `test/probe.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 20

```
// Issue #14: liveTargets could not tell "the probe failed" from "nothing is
// alive", so one failed `tmux list-panes -a` closed every running agent in the
// store. These tests pin both halves of that distinction, because fixing the
// first half is only correct if the second half still behaves as it always
// has.
```

## line 30

```
// dataDir is read at import time, so the store must be pointed at scratch
// before dist/db.js loads.
```

## line 34

```
// This file runs DELETE statements between tests. Prove the store is the
// scratch one before opening it, not after.
```

## line 43

```
// The two failures that must not be confused. Both are produced for real,
// through execFileSync, rather than stubbed.
//
// NO SERVER: a socket dir that never gets one. tmux exits 1 with "error
// connecting to <socket>", which is a fact (nothing can be alive without a
// server) and must sweep. Since tmux ships `exit-empty on`, this is also what
// every hive session looks like once its last pane closes, so it is the
// common case rather than an edge one.
//
// NO ANSWER: a tmux on PATH that fails for some other reason. That is the
// unknown case, and it must never destroy state. A fake binary is the only
// honest way to produce it: every real tmux failure we can stage locally is
// one tmux has an opinion about.
```

## line 62

```
// A fake tmux that runs `shShouldFail` (a POSIX-sh snippet testing "$@") and,
// if it does not exit first, passes the call through to the real tmux. One
// scaffold shared by every "fails call X, honestly passes everything else
// through" fixture below, rather than a hand-copied heredoc per fixture.
```

## line 72

```
// Fails `list-panes -a` and passes everything else through to the real tmux.
// Failing every call would work for the guards, but then nothing observable
// can happen during a tick, and a test whose assertions are all negative
// passes just as well on a tick that threw on its first statement. Breaking
// only the batch probe leaves a due wake still deliverable, which is the
// positive control. It is also the more realistic failure: one call fails,
// not the whole binary.
```

## line 92

```
// Issue #40. Fails only `capture-pane`, passing send-keys and everything else
// through to the real tmux, so a send made through this PATH really lands in
// the pane while the tail read that follows it fails honestly.
```

## line 119

```
// unprobeable: one extra target the fake refuses to answer about, for testing
// the single-target path. Everything else still reaches the real tmux.
```

## line 124

```
// REACHABLE BUT EMPTY: a server with no sessions at all. It takes
// `exit-empty off` to hold one open, which is the point: with the shipped
// default this state is unreachable, and issue #14's "a reachable empty
// server must still sweep" is really about the no-server case. Staged anyway,
// because a user with exit-empty off in their tmux.conf gets exactly this.
//
// Torn down by restoring exit-empty and destroying one throwaway session,
// which makes the server exit on its own. Never kill-server: it takes down
// whatever server the ambient env points at (CLAUDE.md).
```

## line 134

```
// Todo 375, counselors round 2 (F6). isolateTmux registers only the file's
// OWN socket, so this second, bespoke server is invisible to the run-level
// leak check unless it is registered here. Recorded at creation rather than
// after startEmptyServer(), so a file killed before it ever starts still
// hands the checker a socket to ask about.
```

## line 155

```
// Never started, or already gone.
```

## line 162

```
// One tmux server for the whole file, torn down once. cleanup() removes the
// shared socket dir, so calling it per describe would pull it out from under
// the describes still to run.
```

## line 188

```
// Registered at the real scratch project dir so an MCP server started with
// that cwd resolves to this same project.
```

## line 194

```
// Default age clears the janitor's 15-second spawn-race guard, which is a
// separate protection and must keep working. Pass "0 seconds" for a row that
// is still inside it.
```

## line 208

```
// due defaults to an hour out, so a timer only fires when a test asks it to.
```

## line 221

```
// One tool call against a fresh MCP server. Real server, real tmux binary,
// real failure when asked for one: nothing inside hive is stubbed.
```

## line 235

```
// unprobeable: the one target this server's tmux refuses to answer about.
```

## line 239

```
// Wake tools need somewhere to deliver: a real pane on the shared
// session, the way a lead running inside tmux has one.
```

## line 248

```
// janitor and tick sweep the whole store, so rows left by an earlier test
// would land in the next one's counts.
```

## line 255

```
// Paired with stopEmptyServer in the file's after hook.
```

## line 311

```
// No argument: the real probe runs, finds no server, and that is a fact.
// This is the ordinary end of a hive session, not an edge case, because
// tmux exits with its last pane.
```

## line 367

```
// Both cases below start from identical rows: an agent whose target is not
// alive, watched by an idle_any wake. Only the snapshot differs. Delivery
// goes to a real pane so the control case reaches the end of the path
// instead of being cancelled as undeliverable.
```

## line 380

```
// Positive control. tick() swallows every exception, so a tick that threw
// on its first statement would satisfy all the negative assertions below
// and this test would pass on a completely broken tick. A due delay wake
// does not consult the snapshot, so it must fire in this same tick: that
// is the proof the tick ran to the end rather than dying early.
```

## line 398

```
// No injected snapshot: the tick runs its own probe against a tmux whose
// batch call fails. This is the only shape that pins probe -> consumer
// end to end. The due wake still delivers, which proves the tick reached
// its end instead of dying in the catch-all.
```

## line 414

```
// deliver() used to ask about the pane AFTER claiming the timer. A failed
// probe then cancelled a wake that was already spent, and for a repeating
// one that destroys the schedule: fired_at is set, so no other scheduler
// instance ever retries it.
```

## line 464

```
// Issue #5, D3: unknown liveness is treated as "not confirmed alive", the
// same as a dead row, so agent_list still offers the transcript path here
// -- a failed probe is exactly the moment agent_output stops answering.
```

## line 474

```
// Inside the janitor's 15-second guard, so the server's own scheduler
// cannot close the row out from under the assertion.
```

## line 489

```
// agent_status takes the single-target path, which round 1 left alone. It
// is the tool a lead polls before acting on one worker, so it lying is
// worse than agent_list lying.
```

## line 500

```
// D2: agent_status always carries transcript_dir for a claude worker,
// unknown liveness included -- it is the tool a lead reaches for once a
// pane may already be unreachable.
```

## line 507

```
// The dangerous answer here is already_satisfied with "Act now": the lead
// reads a completion that never happened and moves on while the worker is
// mid-task.
```

## line 524

```
// The one round-2 consumer that writes to the world rather than the store.
// On a failed probe it used to close the live row and launch a second copy,
// so a hive.yml dev server ran twice: the original untracked and still
// holding its port, the new one failing to bind.
```

## line 581

```
// The regression pin. Unknown liveness must not become "it is dead, start
// another one".
```

## line 598

```
// Round 2 made each of these decide for itself what an unanswered probe
// means. Each decision was a judgement call, so each needs a test saying
// which way it went.
```

## line 613

```
// Closing a row whose pane may still be up leaks a running worker nothing
// tracks, and the kill could not land anyway while tmux is unreachable.
```

## line 633

```
// The wording is the whole point. A model told "close it with agent_close
// and spawn a new one" does exactly that, to a worker that is probably
// alive and mid-task.
```

## line 640

```
// Immune to generated data: probeFailed() interpolates only agent.id (a
// deterministic autoincrement int) and agent.name into PROBE_FAILED_NOTE,
// and "send-unknown" is a hardcoded literal, not a random/generated
// name. A caller that started reusing a randomly-generated agent name
// here would inherit the risk this pattern is otherwise blind to.
```

## line 651

```
// The other half: that wording is correct when tmux actually answered,
// and this test is what stops it being softened everywhere.
```

## line 666

```
// Everything unknown costs here is cosmetic: the tmux window title and
// claude's own /rename. The store half must still happen, or "the cost is
// only a stale pane label" is not true.
```

## line 689

```
// capturePane in agent_send's wait_ms branch used to run unwrapped, AFTER
// the text was already sent, so a pane that died (or a capture that
// failed for any other reason) during the wait turned a successful send
// into a reported error. A caller reading "error" here reasonably
// retries, and a duplicated instruction mid-task is worse than a missing
// tail (issue #40).
//
// Counselors review on PR #47, finding 1 (both seats independently):
// without the final assertion below, this test passes even with the
// sendText call deleted from agent_send entirely -- requireLive uses
// list-panes (passes through captureFailPath), paneChoiceCheck's own
// capture fails and returns awaitingChoice: null so the text branch falls
// straight to wait_ms, and the receipt comes out byte-identical with no
// text ever having been typed. That proves the receipt SHAPE under a
// capture failure, not that the send landed, which is the one thing
// issue #40 is actually about: sent: true must mean the keystrokes
// reached the pane. Read the pane back with the real tmux binary,
// outside captureFailPath (which only fails capture-pane for the MCP
// server child, not for this test process's own PATH), so a no-op send
// cannot pass silently.
//
// The sent text is unique to this test, not the shared "hello": livePane
// is one pane reused for the whole file, submit: false means no Enter is
// ever sent to clear it, and this describe block's other test sends its
// own literal text into the same pane. A generic "hello" would still be
// sitting on screen from that other send regardless of test order, so a
// shared marker would pass even if THIS test's send never reached the
// pane - it would just be reading the other test's leftovers.
```

## line 734

```
// Its own marker text too (see the sibling test above): livePane is
// shared across this whole describe block, so "hello" left over from the
// other test would satisfy a generic match without this send having
// happened at all.
```

## line 748

```
// A hard-coded empty string would satisfy `typeof tail === "string"`
// without proving capture happened at all, or that it captured what was
// actually sent (counselors review on PR #47, finding 1).
```
