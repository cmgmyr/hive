# Attic: test/agent-resume.test.mjs

Comments removed from `test/agent-resume.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 5

```
// Issue #154, D2/D3: agent_resume is a named operation over `claude
// --resume`, reusing the closed row and its actor_id rather than minting a
// new one -- the same precedent ensureLeadRow (src/cli.ts) already set for a
// lead restart. See src/spawn.ts's resumeAgent for the reasoning.
```

## line 59

```
// pane_pid, not tmux_target: a pane id can legitimately repeat once its
// window (or the whole session) is destroyed and recreated -
// .claude/rules/tmux-and-panes.md documents exactly this ("%0's pid was
// 50926 before a restart, 50942 after ... pane id identical"), which is
// exactly the shape a single-worker session hits here (agent_close kills
// this worker's only pane, which kills its only window, which can take
// the session down with it). pane_pid is the fact that actually proves a
// new process exists.
```

## line 124

```
// A second worker takes the freed name while the first sits closed -
// idx_agents_running_name only constrains RUNNING rows, so nothing stops
// this, and findClosedAgent's own name search would now find the WRONG
// (closed) row anyway - address the original by agent_id to isolate the
// collision this test is actually about.
```

## line 132

```
// Hits agent_resume's own requireNameFree call (counselors, opus),
// which now runs before resumeAgent is ever reached - so this is
// requireNameFree's own message, not resumeAgent's SQL-level backstop
// (that one only fires on the TOCTOU race between this check and the
// write, which a sequential test cannot produce).
//
// Todo 364. requireNameFree's generic "Pick another name" is impossible
// advice here - agent_resume takes no new name for the caller to pick -
// so this row's own resume-aware message is what actually fires now,
// naming the real remedy (free the name, then retry by agent_id).
```

## line 159

```
// idx_agents_running_name's COLLATE NOCASE folds ASCII only, so a
// differently-cased non-ASCII pair passes the DATABASE'S own unique
// index -- this is exactly why requireNameFree (JS-folded) has to run
// first rather than leaning on the index alone.
```

## line 174

```
// Todo 364. The parked half of the message fix above: a resume colliding
// with a running agent gets the SAME resume-aware sentence whether the
// row it is trying to bring back was parked or merely closed, but the
// wording says which - "parked" is the reassurance a next-morning lead
// actually needs (the lane it deliberately paused is not gone, only
// blocked on a name).
```

## line 231

```
// Resume A (lower id) and reclose it AFTER a real gap, so its closed_at
// is unambiguously newer than B's own whole-second timestamp - the
// inversion the old `ORDER BY id DESC` could never produce, since id
// order never changes once assigned.
```

## line 246

```
// Todo 364, second half of the reported bug: "park 'impl' at 18:00, spawn
// and ordinarily close a fresh 'impl' at 09:00, resume 'impl'" used to
// silently resume the WRONG lane - closed_at alone always prefers the
// more recent ordinary close over an older park, with no error to notice
// by. Parked now outranks closed_at entirely.
```

## line 256

```
// A real gap, so the ordinary close below is UNAMBIGUOUSLY later by
// closed_at than the park above - the exact condition that used to win.
```

## line 299

```
// Seeded to a value DIFFERENT from what this test asserts afterward
// (.claude/sessions/dead-ends/2026-07-29-seeding-a-test-row-with-the-
// value-it-asserts.md): a row that already read 'unknown'/NULL before
// resume would pass even with the reset removed.
```
