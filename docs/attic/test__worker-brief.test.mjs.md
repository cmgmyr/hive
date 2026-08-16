# Attic: test/worker-brief.test.mjs

Comments removed from `test/worker-brief.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// brief.js resolves paths from HIVE_DATA_DIR at import time, so point it at a
// scratch dir before the dynamic import below. It reads dataDir.js and never
// db.js, so importing it creates no store.
```

## line 33

```
// hive.yml can say `lead: /opt/homebrew/bin/claude --model opus`, and
// agent_spawn can be handed the same. One predicate answers for the lead
// command, the worker command, and the flags each gets.
```

## line 107

```
// Whoever typed the flag meant it, and claude would otherwise see --name
// twice. extra_args is the caller's escape hatch, so it wins.
```

## line 120

```
// Every form claude's own parser accepts, checked against 2.1.220 rather
// than assumed: all four of these set the name, so all four have to count
// as the caller having named the worker.
```

## line 161

```
// Todo 387: this used to be a separate line agent_spawn typed into the
// pane and submitted. Nothing types it anymore, so it has to survive here
// instead, or a spawned worker is never told to wait for its assignment.
```

## line 174

```
// FIX ROUND 1, FINDING 7. workerBrief returns a profile's worker.md
// VERBATIM (its own early return, above) and never reaches
// defaultWorkerBrief when a profile exists and ships that file - so
// baking the instruction into defaultWorkerBrief alone silently dropped
// it for every profile-using project, including this repo's own
// (hive.yml here sets profile: orchestration). This pins that the
// instruction survives regardless of which branch produced the rest of
// the brief.
```

## line 195

```
// No worker.md written - readProfileFile returns null, workerBrief must
// fall all the way through to defaultWorkerBrief rather than returning
// an empty or partial brief.
```

## line 212

```
// Bounded by project count and derived from the profile, so `hive lead`
// overwrites rather than accumulating a file per run.
```

## line 220

```
// This file used to have a "pane announcement" describe block here, testing
// paneAnnouncement() - the line agent_spawn typed into a fresh pane and
// submitted. Todo 387 deleted the function along with the turn it created;
// the "worker brief file" describe above now covers the one thing it added
// (the wait-for-your-assignment instruction) as part of the brief text.
```
