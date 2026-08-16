# Attic: test/store-isolation.test.mjs

Comments removed from `test/store-isolation.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 10

```
// One case spawns `hive status`, which runs the janitor and probes tmux.
```

## line 14

```
// Issue #22. On 2026-07-28 the suite destroyed every agents and timers row in
// the developer's live store. Nothing was wrong with the test that did it
// except the order of two lines: a static `import { configHash } from
// "../dist/projectYml.js"` at the top of test/helpers.mjs is hoisted above the
// test file's body, projectYml pulls in dataDir, and dataDir resolved the
// store once, into a module-level const, from the env as it stood at that
// instant. HIVE_DATA_DIR was set a few lines later, dist/db.js agreed with the
// cached answer, and the between-test DELETEs ran on ~/.hive.
//
// assertScratchStore() shipped after that and works, but it is opt-in and the
// mistake it catches is exactly "did not realise the import order mattered".
// These tests pin the two structural guards that replaced the rule, and every
// case runs in its own process because the whole subject is what a process
// decides at load time.
```

## line 31

```
// A test runner is the entry point of every case below, stated rather than
// inherited: which of NODE_TEST_CONTEXT or --test the ambient run happens to
// carry is not what any of these are about. See underTestRunner().
```

## line 36

```
// Runs a script in a fresh process and never throws, so a case can assert on a
// refusal and on a success in the same shape.
//
// env REPLACES the environment rather than extending it, which is why this
// does not go through runNode: the point of most of these cases is an exact
// minimal environment, and the "leaves a human alone" one needs
// NODE_TEST_CONTEXT to be absent, which any inherited env would supply.
// TMUX_TMPDIR is passed through so a child that reaches tmux reaches the
// isolated server, not the developer's.
```

## line 63

```
// Fixtures are written into the scratch dir this file already owns. Their
// whole subject is what a process decides while its imports resolve, so each
// one has to be a real file run by a real interpreter.
```

## line 74

```
// The incident, reproduced line for line. The import is above the
// assignment, which is the entire mistake; before the fix this printed
// the developer's real store and the next DELETE went there.
```

## line 94

```
// What resolving at call time cannot fix: db.js picks its store in its own
// module body, so hoisting THAT above the assignment still asks for the
// default. There is no answer to give a test runner here, so it refuses.
```

## line 106

```
// db.ts commits to a store during an import, so the refusal has to be
// printed and exited the way guardAbi does. A throw out of an ESM module
// body reaches the user as a stack trace with hive's sentence buried in
// it, which is the shape CLAUDE.md says to avoid, and a bare
// /refused to use its real store/ match cannot tell the two apart.
// Immune: stderr here is either the plain-text refusal or a genuine
// uncaught-exception stack trace - no scratch path, pid, or session name
// this suite prints is ever indented behind a leading "at ", so this can
// only match the real failure shape it exists to catch.
```

## line 119

```
// An explicit HIVE_DATA_DIR pointing at the real store is the thing being
// prevented, not an exemption from it.
```

## line 130

```
// The guard reads an env var precisely so it crosses a spawn. A helper
// that forgets to pass dataDir hands the child a real store otherwise, and
// the child is where every CLI and MCP test does its writing.
```

## line 139

```
// The guard has to be invisible to every test that does this right, or it
// is just a slower way to fail.
```

## line 151

```
// This test used to assert the OPPOSITE: that any script run outside a
// test runner reached ~/.hive, on the theory that "a test runner is the
// entry point" was the only thing worth refusing. Todo 324 found the gap
// in that theory directly: a hand-rolled step-11 driver is ALSO not a
// test runner, and it reached ~/.hive just as easily. The guard now asks
// a narrower question -- is this process one of hive's own entry points?
// -- and an arbitrary script answers no. See test/store-entry-guard.test.mjs
// for the full behaviour: which five paths ARE recognised, and
// HIVE_ALLOW_DEFAULT_STORE as the deliberate opt-in this case is missing.
```

## line 177

```
// Every case above states NODE_TEST_CONTEXT itself, which is right for
// them and leaves one thing unproven: that the signal underTestRunner
// reads is the one node:test really sets. Without this, Node renaming the
// variable, or a move to another runner, leaves the guard silently dead
// with the whole suite still green. This process IS the ambient runner.
```

## line 188

```
// test/layout.test.mjs imports dist/ statically and never sets
// HIVE_DATA_DIR, which is the shape that caused the incident. It is safe,
// and this is why rather than an assurance: neither module it imports can
// reach the store at all. Pinned as a test because "projectYml and tmux do
// not touch the database" is a property of an import graph, and an import
// graph changes without anyone rereading a test file's header.
```

## line 195

```
// require.cache keys are ABSOLUTE PATHS, and every one of them is rooted
// under this checkout, so a loose substring test for "better" and
// "sqlite" trips on the CHECKOUT'S OWN PATH rather than on an actual
// better-sqlite3 import whenever the repo, a branch, or (as happened for
// issue #105's own worktree, named "issue-105-types-better-sqlite3") a
// worktree directory happens to contain both words. Every module loaded
// from such a checkout — yaml included — would trip it. Match the real
// module location instead: a cache key that actually names
// node_modules/better-sqlite3/ as a path segment, which only a module
// resolved to that package can produce regardless of what the checkout
// itself is called.
```

## line 226

```
// And naming is refused on the same terms as opening, rather than handing
// this process "hive-1". Building a string touches no disk, but the string
// is what kill-session gets pointed at, and hive-1 is a live session.
```

## line 233

```
// A symlink pointing AT the real store must be recognised as the real store.
//
// SAFETY, because this file names ~/.hive on purpose: everything here is
// in-process and side-effect free. dist/dataDir.js opens no database (its own
// header says so), isDefaultStore only calls realpathSync, and storeDir throws
// before returning. Nothing spawns a CLI with this symlink, because `hive
// status` runs the janitor and that IS the destructive path. If the guard were
// broken these assertions would fail; they would not write anything.
```

## line 247

```
// nothing to link at on a clean machine
```

## line 254

```
// resolve() collapses ".." but does not follow symlinks, so this used to
// read as a scratch store while SQLite opened the real one. Both guards
// fell at once: the test-runner refusal below, and untrustedTmuxServer,
// which would have let a private tmux server write pane ids into the
// live database.
```
