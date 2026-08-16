# Attic: src/dataDir.ts

Comments removed from `src/dataDir.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 7

```
// Resolved on its own, with no database side effects, so tmux.ts can derive
// session names without opening the store.
```

## line 12

```
// Where hive keeps its store. HIVE_DATA_DIR points tests and scratch
// instances at a private one.
//
// Read at CALL time. This was a module-level const, and a const is resolved
// once, at the first load of this module, from the env as it stood at that
// instant. Any import landing above the code that sets HIVE_DATA_DIR froze
// the answer for the whole process, and every later import silently agreed
// with it. That is not hypothetical: a static `import { configHash } from
// "../dist/projectYml.js"` at the top of test/helpers.mjs pulled this module
// in at hoist time, so dist/db.js opened the developer's real ~/.hive and the
// suite's between-test DELETEs ran there. Reading the env when someone asks
// removes the ordering question instead of leaving it to be gotten right.
//
// Deliberately NOT exported. It is storeDir() without the refusal, so an
// export would put the one call that reintroduces this whole class of bug in
// the public API, shorter than the guarded one and reading more obviously
// correct. Both consumers are in this file.
```

## line 33

```
// Whether a resolved path names the real store, following symlinks.
//
// resolve() makes a path absolute and collapses "..", but it does NOT follow
// symlinks, so two names for the SAME directory compared as different stores.
// Concretely: /tmp/live-hive symlinked to ~/.hive, with HIVE_DATA_DIR set to
// the symlink, read as a scratch store everywhere in hive while SQLite opened
// the real one. That defeats both guards at once. storeDir() would not refuse
// it under a test runner, so a suite could run its DELETEs against the live
// store; and untrustedTmuxServer() would see "scratch store" and let a private
// tmux server write its pane ids into it.
//
// Only the COMPARISON canonicalises. resolveDataDir keeps returning the path as
// the caller named it, because that string is also what brief and posture files
// are built from, and rewriting it to /private/var on macOS changes paths that
// callers hand back to hive. The question here is "is this the real store",
// which is about identity on disk, not about spelling.
//
// A path that does not exist cannot be a symlink to anything, so the lexical
// answer stands. That is the ordinary first run: hive creates its data dir on
// demand.
```

## line 65

```
// True when a test runner is the entry point of this process, or of the one
// that spawned it.
//
// node:test runs each test file in its own process and sets NODE_TEST_CONTEXT
// there; the value has changed between Node versions ("child", "child-v8"),
// so only its presence is load-bearing. It is an env var, so every CLI and
// server the suite spawns inherits it, which is what makes the guard below
// cover children that forgot to pass HIVE_DATA_DIR. Under
// --test-isolation=none the files run in the runner itself, which carries
// --test on execArgv instead.
```

## line 79

```
// Absolute paths to hive's own scripts, computed from where THIS module was
// loaded rather than hardcoded, so a checkout at any path -- or a worktree --
// matches its own build. cli.js, index.js and hook.js are dist/'s other three
// entry points (the CLI, the MCP server, and the Claude Code hook that writes
// worker state); kickoff.js is dist/kickoff.js's own documented direct-entry
// mode (see its header). claude-plugin/kickoff.mjs is the one that lives
// OUTSIDE dist/: Claude Code's SessionStart hook runs it directly, before it
// dynamically imports dist/kickoff.js, which is what makes it a distinct
// entry point rather than an alias for one already in the list above.
```

## line 99

```
// True when this process's OWN entry point -- process.argv[1], set by node
// before any user code runs, so no import order can move it the way an env
// var the CLI or server set at the top of its own file could (that would be
// the 2026-07-28 hoisting bug in a new hat: by the time such a line ran,
// db.ts's module body may already have chosen a store) -- is one of hive's
// own scripts, rather than something a person wrote to drive or inspect one.
//
// Compared as a resolved path, not a basename. A basename check would call
// any unrelated file named "index.js" a match, which is a wider hole than an
// exact path needs to accept; canonicalised on both sides so an npm bin
// symlink, or the plugin's own ~/.claude/skills/hive symlink, still resolves
// to the file this is actually asking about (same reason isDefaultStore
// follows links, above).
//
// This is a guardrail against a confused author, not a security boundary --
// nobody is attacking this, people are writing a seed script at 1am -- and
// HIVE_ALLOW_DEFAULT_STORE (see storeDir, below) is the deliberate escape
// hatch for the legitimate case this cannot see: a one-off human inspection
// that is not any of the five paths above.
```

## line 125

```
// The data dir for anything that opens or writes the store, as opposed to
// merely naming something after it.
//
// resolveDataDir removes the trap that lost a live store, but only for code
// that asks after the env is set. A module that opens the store at its own
// load time still gets whatever the env said then, so a static
// `import "../dist/db.js"` above the line setting HIVE_DATA_DIR would still
// reach ~/.hive. Under a test runner there is no such thing as a legitimate
// reason to touch the real store, so this refuses rather than trusting the
// next author to have read this file.
//
// An explicit HIVE_DATA_DIR pointing at ~/.hive is refused too. A test that
// names the real store is the exact thing being prevented, not an exemption.
//
// NAMING HAS SINCE CHANGED (topology-3c). sessionName() takes no project
// argument now and returns "hive-main" for the default store - one session
// per STORE, one window per project inside it, never a session per project.
// Every sessionName(1)/"hive-1"/"<hash>-1" example below, here and in
// tagFor's comment further down, is an INCIDENT RECORD from before that
// change: read it for what actually happened under the old naming, not as
// current API. Left exactly as written on purpose - the incidents are real
// and rewriting them into the new naming would falsify the record - but a
// reader meeting "hive-1" for the first time should know it no longer names
// a session before trusting the rest of the story.
//
// Naming goes through here too, via dataDirTag. It used to be exempt on the
// grounds that building a string touches no disk, which answered the wrong
// question: a session name is the TARGET ARGUMENT for kill-session and
// respawn-pane. sessionName(1) under a test runner with no HIVE_DATA_DIR
// returned "hive-1", the live session of whatever real project is id 1, and
// agent_close would have killed it with its workers inside. Naming a store you
// are refused permission to open is not a case worth serving; tagFor takes a
// directory when a caller genuinely means one.
//
// Throws, because profiles.ts and brief.ts call it mid-command where exiting
// the process would be too blunt, and because a throw is what lets a test
// assert on the guard instead of dying with it. db.ts calls it during an
// import and needs the other treatment: see guardStoreDir below.
```

## line 170

```
// storeDir for a caller running inside an import, which today means db.ts.
//
// Same check, printed and exited rather than thrown, for exactly the reason
// guardAbi in src/abi.ts prints and exits: a throw out of an ESM module body
// reaches the user as a stack trace with hive's sentence buried in the middle
// of it, and nothing downstream can catch it to say anything better. The
// stdout/stderr split follows guardAbi too. Only the MCP server writes
// JSON-RPC on stdout, so the diagnostic goes to stderr where it cannot corrupt
// a protocol stream.
```

## line 189

```
// The one decision storeDir() and guardStoreDir() both make, so they cannot
// drift apart. Two refusals, checked in order, and the order is load-bearing:
//
// A test runner is refused OUTRIGHT, with nothing below able to un-refuse it.
// HIVE_ALLOW_DEFAULT_STORE is an override for a HUMAN's one-off script, never
// for a test process; folding the two checks into one would let a test that
// sets it (by accident, by copying an example, by a future author reaching
// for the obvious-looking fix) reach live state, which is the exact failure
// this file exists to prevent.
//
// Below that: anything that is not hive's own CLI, MCP server, or hooks
// (isProductEntryPoint, above) is refused too, UNLESS the human running it
// set HIVE_ALLOW_DEFAULT_STORE=1 -- the deliberate opt-in for a legitimate
// one-off against the real store, which isProductEntryPoint cannot itself
// recognise. This is the gap: a hand-rolled driver script that sets
// HIVE_DATA_DIR for a child it spawns, then imports dist/db.js in ITSELF to
// seed or inspect a row, was never a test runner and was never refused.
```

## line 214

```
// One wording per reason, so a test that pins a sentence pins the path that
// produced it. Written for someone who has never read hive's source: the way
// out is named before anything else, whichever reason fired.
```

## line 233

```
// Project ids are SQLite row ids, unique only within one store: project 1 in
// a scratch store is a different project from project 1 in ~/.hive. tmux
// session names are built from those ids and share one machine-wide
// namespace, so an isolated store would otherwise resolve to -- and act on --
// the live session of whatever real project happens to be id 1. Tagging the
// name with the store keeps the default case readable (hive-1) and puts every
// other store somewhere it cannot collide.
//
// Takes the directory rather than resolving one, so a caller that means a
// specific store says which. Everything that means "this process's store"
// wants dataDirTag, which is guarded.
//
// Canonicalised first, and this was the third place that had to learn it. A tag
// identifies a STORE, and a store is identified by where it is on disk, not by
// how the path is spelled. e0d6be5 taught storeDir, guardStoreDir and
// untrustedTmuxServer to follow symlinks and left this one comparing strings,
// so HIVE_DATA_DIR symlinked at ~/.hive produced a hash tag here while
// isDefaultStore said it was the default store, and sessionName handed back a
// tagged name for the very project hive-1 names under the literal path.
//
// Not cosmetic, whatever the narrow trigger suggests. A session name is the
// target argument for kill-session and respawn-pane, which is exactly why
// dataDirTag was pulled behind the guard to begin with (see the store isolation
// invariant in CLAUDE.md). One project answering to two session names means a
// lead calling agent_close on hive-1 while its workers live under <hash>-1:
// workers nothing can reach and a session nothing can kill.
//
// The hash takes the canonical path too, not just the comparison, so the rule
// is one rule rather than two. Two aliases of a SCRATCH store would otherwise
// split into two namespaces for the same reason, which is the identical defect
// one store further out. A path that does not exist canonicalises to itself, so
// naming a store before it is created still answers.
```

## line 272

```
// The tag for the store this process may use. Guarded, because the name it
// builds is what destructive tmux commands are pointed at: see storeDir.
```
