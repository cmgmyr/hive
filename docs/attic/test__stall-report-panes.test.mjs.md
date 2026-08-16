# Attic: test/stall-report-panes.test.mjs

Comments removed from `test/stall-report-panes.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 18

```
// TODO 391, ARM 2 - the half an implementer is most tempted to drop, and the
// half that covers the commonest death shape on a machine that actually
// prompts.
//
// WHY IT EXISTS AT ALL. stateForNotification (src/hook.ts) returns `waiting`
// for every notification that is not idle_prompt, latched until that turn's
// own stop, so a turn that dies AFTER a permission prompt reads `waiting` and
// never `working`. Measured against the live store: real workers sat `waiting`
// for 3.9 and 11.5 minutes, and three notify|waiting rows were the LAST ROW
// their worker ever wrote. An arm-1-only implementation passes every row of
// test/stall-report.test.mjs and misses all of that.
//
// THESE THREE CASES NEED A REAL PANE, which is why they are not in that file:
// arm 2's evidence is a FRESH, DEFINITE `awaitingChoice === false`, and the
// three answers it can give (false, true, null) are three different outcomes.
// The null case is pinned next door, since "no fact" is reachable without a
// pane at all.
//
// Real tmux, real spawned workers, real dialog fixtures, and the MCP server's
// own natural scheduler tick - the method test/wake-hold-notify.test.mjs uses
// for the sibling condition.
//
// EVERY ASSERTION IS OVER A RECORD OF WHAT HAPPENED: timers rows,
// wake_idle_notices rows and wake_block_notices rows, never a sample of
// agents.agent_state (test/CLAUDE.md).
```

## line 47

```
// Claude Code relocates its whole state tree - transcripts included - when
// this is set, so hive resolves a worker's transcript under a directory this
// file owns instead of the developer's real ~/.claude.
```

## line 70

```
// TWO PANES FOR THE WHOLE FILE, spawned once and repainted per case rather
// than a fresh pair per case. Every pane is a pty, and this suite has hit
// `fork failed: Device not configured` on a loaded machine - six panes to
// exercise three screens is a cost with no assertion behind it. Nothing here
// is about pane identity, so repaintPaneAsSameWorker is the right
// instrument (its own comment says as much).
```

## line 101

```
// The store's own account of a worker latched `waiting`: what src/hook.ts
// writes on a Notification. Written directly because a fake claude fires no
// hooks - the pane fixture supplies the screen, this supplies the latch that
// decides whether hive bothers to look at it, and the session_id that decides
// which transcript it samples.
//
// `since` is the EPISODE, shared by the stall claim and the block claim, which
// is the whole point of the cross-condition rule below.
```

## line 117

```
// The transcript Claude Code would have written for that session, at a chosen
// age. hive resolves it as <transcriptDir(agents.cwd)>/<session_id>.jsonl.
```

## line 128

```
// A standing watch owned by, and delivered to, a live worker's pane - the
// test session itself is a rowless `user:` actor with no pane, which is a
// genuine "nobody to tell" case the detector skips.
```

## line 142

```
// A stall notice is the only notice this watch files that carries a parent
// link (claimBlockBatch passes null), so the parent is the discriminator
// between the two conditions rather than a substring of prose.
```

## line 160

```
// ONE MCP SERVER AND ONE STORE SERVE EVERY CASE, and the crew is a QUERY
// rather than a list, so an earlier case's leftovers are members of the next
// one's. Each case therefore starts from a known floor: the latch cleared
// (which takes the row out of the stall population without closing it, since
// closing would put it into the gone half's instead) and every earlier watch
// retired so its own ticks stop adding rows to the tables this case counts.
//
// EACH CASE ALSO GETS ITS OWN EPISODE. The episode key is the latch's own
// moment and both the stall claim and the block claim are keyed on it, so
// reusing one value across cases would let case two lose a claim case one
// already made and read as a product decision.
```

## line 184

```
// THE ROW THE WHOLE MATRIX EXISTS FOR. Without it, an implementation that
// ships ARM 1 ONLY passes every other test in this lane.
```

## line 190

```
// ASSERT THE WAIT ITSELF. `until` RETURNS false on timeout rather than
// throwing, so an un-asserted call turns a slow machine into a confusing
// failure on the NEXT assertion instead of naming the real cause.
```

## line 212

```
// A LIVE DIALOG BELONGS TO THE BLOCK HALF, NOT HERE. Being wrong in this
// direction means telling a lead that a worker sitting on a prompt nobody
// has answered has a dead turn - a different remedy from the true one, on
// the one fact that decides what to do next.
```

## line 220

```
// The block half speaking is the POSITIVE CONTROL: it proves this fixture
// reached the code at all, so "no stall notice" is a decision rather than
// a tick that never ran.
```

## line 227

```
// Several more ticks with the dialog still up.
```

## line 235

```
// THE CROSS-CONDITION CLAIM. The block half and arm 2 read ONE population,
// so without a shared key they claim in different tables and the lead gets
// two paragraphs about one worker that contradict each other on the one
// fact that decides what to do next. The sequence below is the real one: a
// dialog goes up and is reported, a human answers it, and the pane then
// shows no dialog while the LATCH HAS NOT MOVED - which is exactly what arm
// 2 fires on.
```

## line 252

```
// The dialog is answered. The pane clears; the latch does NOT move,
// because nothing about answering a dialog writes a hook event on its
// own - which is the very latch this feature exists to distrust.
```
