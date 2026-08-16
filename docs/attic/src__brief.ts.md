# Attic: src/brief.ts

Comments removed from `src/brief.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 8

```
// The worker bootstrap.
//
// The brief is the authoritative text and rides in the system prompt via
// --append-system-prompt-file: prompt-cached, uncompactable, impossible for the
// lead to forget. But an appended system prompt is invisible in the TUI and
// absent from the transcript, so hive owes the human an audit trail of its own:
// the copy it wrote for this agent stays on disk
// (writeAgentBrief/agentBriefPath below), readable long after the pane is gone.
// Nothing is typed into the pane itself anymore - agent_spawn used to type a
// short line naming the agent as the worker's visible first turn, and stopped,
// because that typed line WAS a turn hive asked for itself, and everything
// downstream of it was machinery for managing a turn nobody else asked for.
//
// This module deliberately imports dataDir.js rather than db.js; resolving a
// brief path must not open or migrate a store.
```

## line 30

```
// The project's profile, when it has one, and its hive.yml vars. A project
// without a profile keeps the built-in brief below.
```

## line 36

```
// Agent identity is addressable in worker.md the same way project vars are.
// Identity wins: a project cannot redefine which agent this is.
```

## line 49

```
// "Run whoami to confirm scope, then wait for your assignment" used to be a
// separate line agent_spawn typed into the pane and submitted, which created a
// real turn hive asked for itself. Everything that line established as fact is
// already above it in the brief; this instruction is the one thing it added, so
// it has to survive as text instead. Appended by workerBrief itself (below)
// rather than baked into defaultWorkerBrief alone: a project with a profile
// never reaches defaultWorkerBrief at all - workerBrief returns a profile's own
// worker.md verbatim - so putting the instruction only in the fallback silently
// dropped it for every profile-using project, including this repo's own
// (hive.yml here sets profile: orchestration). One place every worker's brief
// passes through, regardless of where the rest of it came from.
```

## line 70

```
// The fallback for a project with no profile, and for a profile that ships no
// worker.md. Every worker gets a brief, profile or not.
```

## line 91

```
// Written per agent, not once per machine: the text names the agent, and the
// copy on disk is what agent_status reports long after the pane is gone.
```

## line 108

```
// The lead's posture, same shape one level up: a rendered system-prompt file
// on disk, keyed by project instead of by agent.
//
// It has to be rendered somewhere, because --append-system-prompt-file takes
// a path and the file in the profile still holds its {{vars}}. One file per
// project, overwritten on every `hive lead`: the set is bounded by how many
// projects you have, the content is derived, and a stale copy from a deleted
// project costs a few hundred bytes. Nothing sweeps them, deliberately.
```

## line 132

```
// All three are claude's; other agent commands get the bare command.
```

## line 135

```
// The hive name, passed as claude's --name. claude otherwise writes a
// summary of what the session is doing into the terminal title and keeps
// updating it, so a worker's pane says everything except who it is. An
// explicitly set name is sticky for the life of the session.
```

## line 142

```
// --settings and --append-system-prompt-file are claude's alone, so every
// caller that adds one has to answer this the same way. The command may carry
// arguments and may be an absolute path: `lead: /opt/homebrew/bin/claude
// --model opus` is still claude.
```

## line 153

```
// --name is the one flag here a caller can also express directly, since it
// carries a value hive derived rather than a path hive owns. Whoever typed
// it meant it, and claude would otherwise be handed the flag twice.
//
// Every form claude's parser accepts has to count, or the check misses the
// duplicate it exists to prevent. Confirmed against 2.1.220: `--name x`,
// `--name=x`, `-n x`, `-n=x` and `-nx` all set the name. A single-dash
// token starting with -n is therefore always this flag; -n is a short flag,
// so anything after it in that token is its value, not another flag.
```

## line 171

```
// State hooks (working/idle/waiting) ride along via --settings; the brief
// rides along as an appended system prompt.
```
