# Attic: test/agent-park.test.mjs

Comments removed from `test/agent-park.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 14

```
// Issue #156 (todo 353 lane B). agent_park fills .claude/rules/tool-contract.md's
// RETIRE cell for agents - soft, reversible, still readable by id - where
// agent_close is Remove. A parked lane is a CLOSED row with parked_at set, never
// a third `status` value (D1: `status` is branched on in the janitor's sweeps,
// isLive, requireNameFree, idx_agents_running_name, agent_list, standingIdleRows
// and `hive status`, and an additive column is ignored by all of them by
// construction).
//
// EVERY ASSERTION HERE READS THE ROW OR THE COMMAND'S OWN OUTPUT, never only a
// receipt: a receipt is the handler's claim about itself, and this suite has
// already shipped a green run over a handler that returned {sent: true} without
// delivering anything (.claude/rules/tmux-and-panes.md).
```

## line 37

```
// A REAL GIT CHECKOUT, because parked_branch is read with real `git rev-parse`
// and a fixture that stubbed it would prove nothing about the one fact this
// column exists to capture. Initialised on the project dir itself so the spawn
// stays inside the project hive resolved (.claude/rules/project-scoping.md);
// -b names the branch explicitly rather than depending on whatever this
// machine's init.defaultBranch happens to be, which is exactly the kind of
// one-machine assumption CI catches late.
// scratchGit, not a local execFileSync: it also neutralises a developer's
// global core.hooksPath, and the commit below runs inside before(), so a
// husky-style global hook would take the whole file down rather than one case.
```

## line 83

```
// THE PANE, READ BACK, and this assertion is the reason the file's header
// claim is true rather than aspirational. Counselors (all three seats)
// found that removing `if (live) killAgentPane(...)` from agent_park left
// this entire file green: every other assertion here is a row or a
// receipt, resume creates a fresh pane regardless of whether the old one
// died, and isolateTmux's exit handler reports leftover SESSIONS, not
// panes. So every park would have leaked a running claude nothing tracks,
// with a green suite - the {sent: true} shape .claude/rules/tmux-and-
// panes.md names by name and this file's own header disclaims.
```

## line 98

```
// The ROW, not the receipt. A parked lane must be indistinguishable from
// an ordinary close to every consumer that gates on `status` - that is
// D1's whole argument - and distinguishable to anything that reads
// parked_at.
```

## line 115

```
// The board line is the deliverable half of issue #156 ("anything the lead
// has to remember to write down is a thing that gets skipped at 18:00 on a
// Friday"), so it is asserted on content rather than on existence: a cold-
// boot session needs which lane, on which branch, where, and the one call
// that brings it back.
```

## line 133

```
// Written by the WORKER's actor_id, which is what a real lane produces by
// following the runbook - the point of deriving rather than asking the
// lead to pass it.
```

## line 156

```
// REFUSED MEANS NOTHING HAPPENED. The pane must still be up and the row
// still running - a park that killed the pane and then declined to stamp
// the row would be the worst of both. Both halves asserted, because the
// comment claimed both and only one was checked (counselors).
```

## line 180

```
// seedLeadRow, the shared fixture for exactly this shape (agent_rename and
// wake_when_idle's lead guards use it). Its empty session_id does not
// weaken the case: park's lead refusal runs before the session_id check.
```

## line 195

```
// The case parked_branch exists for, reached from the wrong end. Without
// this refusal the park SUCCEEDS and marks the lane resumable, branchAt has
// nothing to read so it records '', and next morning agent_resume declines
// with advice saying agent_park would have recorded a branch - which it did
// run, and could not. The lead removed a worktree out from under a running
// worker on 2026-08-11, so this is not hypothetical.
```

## line 220

```
// The message a lead hits FIRST the next morning, reaching for the worker
// by the name it knows. It used to say "is closed. Spawn a new worker" -
// the exact confusion issue #156 was filed about, produced by the feature
// built to end it (counselors).
```

## line 237

```
// releaseParkRow directly, because the interleaving counselors named lives
// INSIDE one agent_close call - findAgent reads the parked row, a
// concurrent agent_resume flips it running and clears the stamp, and only
// then does the release run. Driving agent_close from outside cannot
// produce that ordering: by the time the resume has landed, findAgent sees
// a RUNNING row and correctly takes the ordinary close path instead. The
// guard is the write, so the write is what this tests.
```

## line 246

```
// Now the state the race leaves: running, stamp already cleared. An
// unconditional UPDATE no-ops here and its caller answered
// {closed: true, park_released: true} over a live worker.
```

## line 269

```
// The stale-state failure D4 exists to prevent, reached from inside the
// feature: a parked_at left behind would make `hive status` report this
// lane parked for the rest of the row's life.
```

## line 298

```
// The cwd is rewritten to a path that never existed rather than deleting
// the real project dir out from under the running MCP server, which would
// take the rest of this file with it. The condition under test is
// existsSync(cwd) either way.
```

## line 306

```
// The remedy has to be REACHABLE. Without parked_branch this could only
// say "the directory is gone"; the whole return on that column is that the
// error carries the line that fixes it. And it must not surface as Node's
// own ENOENT, which names the BINARY rather than the missing cwd
// (.claude/sessions/common-issues/enoent-names-the-binary-when-the-cwd-is-gone.md).
```

## line 313

```
// One alternative, not two: the second used to subsume the first, so the
// test did not actually pin that the RECORDED cwd reaches the command.
```

## line 324

```
// Todo 369. agent_park kills the pane, then takes parkAgentRow's own
// conditional write - same shape and same reporting gap as agent_close's
// (test/agent-close-honest-cas.test.mjs's own header explains why the real
// race has no hook to interject on, and why targeting by agent_id against
// a row pre-mutated to look already-retired reaches the identical
// lost-CAS code path a genuine race would).
```

## line 334

```
// The exact write shape parkAgentRow itself performs - stands in for a
// concurrent agent_park winning the race this call is about to lose.
```

## line 352

```
// Stands in for a concurrent PLAIN close winning the race - the row is
// retired, but not as a park, so no branch was recorded through this
// call and the old "row changed, nothing was parked" message would have
// been silent about which of those two very different outcomes happened.
```

## line 379

```
// The distinction the issue says a next-morning lead cannot make today:
// `closed` currently means both "this lane is done" and "this lane is
// paused".
```
