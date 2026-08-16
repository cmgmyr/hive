# Attic: src/kickoff.ts

Comments removed from `src/kickoff.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 5

```
// Type-only: erased at compile time, so this costs nothing on the cold path
// every session start pays (unlike a value import of stateProvenance.js,
// which stays inside digest() below for that reason).
```

## line 9

```
// This file's first top-level value import of a local module - a deliberate
// exception to the deferral pattern above, not an oversight. The pattern
// exists for modules like stateProvenance.js that drag in the database and
// the native addon; slug.js is a leaf with no imports of its own (see its
// header), so importing it here costs one small parse and nothing else on
// the cold path every session start pays.
```

## line 17

```
// SessionStart entry point. This runs on EVERY session start in EVERY
// directory on the machine, so it is built to say nothing as fast as
// possible: the cheap file and git checks come first, and the database is
// only opened once a directory has proven it is a hive lead checkout.
//
// Silence is the contract. hive.yml is committed, so a teammate without the
// profile it names, or a session on a feature branch, must get no output and
// no error -- just a note from hive doctor.
```

## line 26

```
// Claude Code caps hook output (additionalContext, systemMessage, plain
// stdout) at 10,000 characters and spills the rest to a file. Everything
// below is budgeted to stay well inside that.
```

## line 35

```
// Why it stayed silent, for `hive kickoff --explain` and the tests. Never
// printed during a real session start.
```

## line 39

```
// hive.yml parse warnings, present once the file has been read. Absent for
// the gates that decline before that (worker session, no hive.yml here):
// nothing was parsed, so there is nothing to report. hive doctor is the
// check that looks at a project's config from anywhere.
```

## line 54

```
// Not a git repo, or no commits yet.
```

## line 59

```
// cutToUnitBudget stops the cut from landing inside an astral
// character's surrogate pair. No round-trip constraint on this output, so
// the "\n[truncated]" suffix is not counted against limit - same as before.
```

## line 67

```
// The live digest. Imported lazily by run() so a directory that fails an
// earlier gate never opens the store.
```

## line 77

```
// Registered, and the session is at its root. A worktree resolves to the
// primary checkout's project, so this is what keeps the kickoff off
// worker checkouts even when they sit on a lead branch.
```

## line 85

```
// Directly under the header, above everything that can grow. truncate cuts
// from the end, so a warning placed here survives a board that fills the
// whole budget; below the board it would be the first thing lost, and a
// warning the lead never sees is no warning. `! ` matches what `hive lead`
// and `hive start` print for the same messages.
```

## line 91

```
// Where the state sections start. "Nothing is in flight" is about the store,
// so it must not be silenced by a warning having been pushed above it.
```

## line 100

```
// archived_at IS NULL throughout (#15): this digest is the first thing a
// lead reads at cold boot, which is exactly when a closed lane's archived
// scaffolding must stay invisible - the same reasoning as cmdStatus's
// open-todos count in src/cli.ts.
```

## line 140

```
// resumed_at: this block is INJECTED into a
// fresh lead's context next to the instruction to triage it, so a worker
// that has been given nothing must not read here as one that finished.
// deriveProvenance needs the column to say so.
```

## line 149

```
// Rows only; liveness would mean shelling out to tmux on every session
// start. hive doctor and agent_list are where dead rows get resolved, so
// alive is passed as null (not probed) rather than guessed.
```

## line 159

```
// Issue #156. THE DIGEST IS THE ONE SURFACE THAT REQUIRES NOBODY TO REMEMBER
// ANYTHING, which is exactly this feature's thesis: the issue's complaint is
// that "anything the lead has to remember to write down is a thing that gets
// skipped at 18:00 on a Friday". Parked lanes now appear in `hive status`,
// which is right and is still a command somebody has to run. A crew parked on
// Friday and not mentioned at 09:00 on Monday is the failure the issue
// describes, reached from inside the fix.
//
// A COUNT AND A POINTER, not a listing, and the two reasons differ from
// `hive status`'s. This text is INJECTED into every session's context and is
// truncated to CONTEXT_BUDGET, so three lines per lane would push out the
// todos above it; and the lead reading this is about to run triage anyway,
// where `hive status` gives the branch, the cwd and the resume call. The
// WORKERS block above makes the same trade for the same reason.
```

## line 206

```
// 1. A hive-spawned worker gets its brief from agent_spawn, not from this.
// HIVE_LEAD, not HIVE_AGENT_ID alone: issue #27 gave the lead an agents row
// too, so HIVE_AGENT_ID is now set for both. This still has to stay a plain
// env check, not a database lookup - it is the check that keeps this hook
// free in every unrelated directory on the machine, and it runs before
// check 2 opens hive.yml, let alone the store two gates further down.
//
// === "1", not truthiness (issue #27): a worker's env carries HIVE_LEAD unset
// today, but a truthy check treats ANY non-empty value as "this is the lead",
// including the literal string "0" - the one value a future caller would most
// plausibly write meaning false. That would let a worker past the one gate
// that exists specifically to keep it from opening the store at all.
```

## line 229

```
// 2. No hive.yml, no kickoff. This is the check that keeps the hook free
// in every unrelated directory: it runs before the store is opened.
```

## line 233

```
// 3. A profile this machine actually has. A hive.yml naming one it does
// not is silence, not an error.
//
// Everything below is imported lazily for the same reason the store is:
// projectYml pulls in the YAML parser, which is ~15ms of module evaluation
// that every directory on the machine would otherwise pay to reach a
// decision the two checks above already made.
```

## line 243

```
// Every gate from here on carries the warnings out, so `hive kickoff
// --explain` can report a malformed hive.yml even for a session start that
// declined.
```

## line 248

```
// Still silence, even when `warnings` is non-empty. A hive.yml broken badly
// enough to lose its `profile` key is exactly the case where hive does not
// know whether this directory is a lead checkout at all, and firing to
// announce that would break the contract at the top of this file: a
// teammate without the profile, on the wrong branch, or in an unrelated repo
// must get nothing. `hive doctor` reports this one instead, from anywhere.
```

## line 257

```
// 4. A lead branch. A worktree on a feature branch is a worker's, not a
// lead's. A project outside git has no branch to be wrong about.
```

## line 265

```
// 5. Registered, and this is its root. First gate that needs the store.
```

## line 279

```
// The digest is already capped, so only JSON escaping can push it over.
// Trim the context and serialize again: slicing the finished JSON would
// buy a length limit at the price of output Claude Code cannot parse.
```

## line 294

```
// A hook that fails is a hook that interrupts the human's session start.
// Whatever went wrong (a locked store, a corrupt hive.yml), silence is
// the correct output; hive doctor is where problems get reported.
```

## line 300

```
// --explain is the human's only window into a hook that is silent by design,
// so it reports a malformed hive.yml whether or not the kickoff fired. The
// declined case is the one that matters: nothing else in that session says
// anything at all. Printed above the payload rather than folded into it,
// because the reader of --explain is a person, not Claude Code.
```

## line 314

```
// Direct entry. The plugin's SessionStart hook runs this file rather than
// cli.js, whose top-level imports would open the store in every directory on
// the machine before a single gate had been evaluated.
```
