# Session continuity

## Problem

A session reopens after a break and re-derives decisions it already made,
or loses track of what it was about to do next, because nothing carried
that forward.

## Offer when

The user says a reopened session repeats itself or has lost the next
action. Interview dimensions 33, 40, 35. Both routes.

## Requirements

Whatever record the user already keeps work in (a tracker, a hive todo, a
plain note); this recipe writes a habit around that record; it does not
invent a new one. If the user has no such record yet, offer a hive todo
comment as the smallest starting point, and only add it once they agree.

## Add

A short finish/start habit in `runbook.md`:

```markdown
SESSION CONTINUITY
Before ending a session, record the outcome, any unresolved choice, and
the next action in <the user's existing record>. The next session reads
that record before starting new work.
```

## Verify

Confirm a fresh session, reading only that record, can name the next
action a prior session left behind.

## Remove

Delete the added habit from `runbook.md`. Historical entries already
recorded stay; removing the habit only stops new ones.

## Boundaries

This does not create a new pad, a session directory, or any tool beyond
what the user already uses to record work. It is a habit, not a mechanism.
