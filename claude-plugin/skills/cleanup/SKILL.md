---
name: cleanup
description: Trims a hive project's board pad, closes finished todos on evidence, archives pads that describe finished work, and cancels stale wake-ups. Fires proactively, not only when asked - use it when a lane or wave has just finished, a worker was just closed, a merge just landed, the session is wrapping up, or the board pad describes state that is no longer true, as well as when the user says /hive:cleanup, "clean up the board", "tidy the store", "close this out", or "the board is stale".
---

# hive cleanup

## Read everything first

You cannot tell live state from dead state off a partial view. Before changing anything, read the board pad in full, `todo_list(status="open")`, `pad_list`, `agent_list`, and `wake_list`. A trim done off a truncated board deletes state nobody read.

## The test for the board

One question, asked of every block: is this true right now? Not "was it true," not "is it interesting," not "did it take effort to learn." A board is live state. A lane that merged, a worker that is gone, a hypothesis that was killed, a baseline that was superseded, a question that got answered - all of it becomes history the moment it stops being true, however recently it was written.

## Never delete evidence - route it

This is the rule that keeps a cleanup from being a loss. Before removing a block, decide where it belongs and put it there first:

- a number someone will reuse (a baseline, a measurement, a count) -> the todo it belongs to, as a comment, or the project's own standing-lessons record if it keeps one
- why something was decided -> a comment on that todo
- a standing lesson that outlives this work -> wherever this project keeps standing lessons, if it keeps any
- what a lane shipped -> its todo's close-out comment and the commit message
- live state that has simply stopped being live -> delete it, that is the job

The failure this guards against is specific: trimming a board and destroying the only record of a measurement, because it was written on the board and nowhere else.

## Archive the old board before you rewrite it

`pad_archive` the board, then write a fresh one carrying forward only what is still live. The old picture stays readable with `pad_list(include_archived=true)`. This is the shipped idiom - a hive project's own starter runbook says it under board discipline - and it is what makes a bad trim recoverable instead of permanent.

## Todos: close what is done, and only on evidence

A merge sha, a shipped file, a recorded decision - not a worker's summary and not your own memory of the session. If you cannot name the evidence, leave it open and say why.

Write the close-out comment before completing, never after and never not at all: what landed, what was deliberately not built, and what a future reader would otherwise re-derive. A todo closed with no close-out has thrown away the only durable record of the work.

`todo_complete` returns `newly_unblocked`. Say what the closure freed - that is the queue moving, and it is invisible if you do not report it.

A todo whose body has been superseded by its own comments is not done, it is misleading. Say so on the todo rather than closing it.

## Pads: a plan pad for a lane that shipped is history

Archive it. A pad still describing in-flight state for work that finished is worse than no pad, because the next session reads it as current. Archiving is reversible and deleting is not, so archive by default and delete only what was never anything but scratch.

## Wakes: cancel what is finished, keep what is deliberate

A watch armed for a crew that is gone is noise. A dated reminder someone set on purpose is not - cancelling one silently loses a commitment nobody will notice missing until the date passes. If you cannot tell which it is, leave it and say so.

## Residue you report and do not remove

Worktrees, branches, running agents. Removing a worktree can destroy uncommitted work, and a running agent may be mid-turn. Name what you found and let the human or the lead decide.

## Finish by saying what you left, not just what you changed

A cleanup that reports only its edits cannot be audited, and the interesting part is usually what was deliberately not touched. Leave the board in the shape the next session needs: where the code is now, whatever verification number this project quotes, what is genuinely in flight (often nothing), and what is waiting on a human.

## Where to route evidence in this project

The board pad is universal - `hive init` seeds one in every hive project, and the shipped runbook template defines board discipline, so route freely to it. A pad for standing lessons is not universal; it is one team's convention, under whatever name that team gave it. Use one only if this project already has one. If it does not, put the evidence in a todo comment rather than inventing a pad the project never agreed to.
