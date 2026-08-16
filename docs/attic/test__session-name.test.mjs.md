# Attic: test/session-name.test.mjs

Comments removed from `test/session-name.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 10

```
// A process per case, each with its own env. sessionName reads the data dir
// when asked rather than at module load, so this is no longer the only way to
// vary the store (see the call-time case at the bottom of this file); it stays
// because it exercises the whole path a real hive process takes, from an env
// var through to a name, rather than a function call in a process that already
// decided.
```

## line 20

```
// stderr piped rather than inherited, so the refusal case can read it
// instead of printing it into the suite's output.
```

## line 27

```
// The default store is reachable only when a test runner is NOT the entry
// point AND (todo 324) the caller is one of hive's own entry points or has
// said explicitly that it means to touch the real store anyway, so the cases
// that want it ask the way a human at a terminal does. This process cannot
// ask: hive refuses to name a store it would refuse to open, because the
// name is what kill-session gets pointed at. A `node -e` one-liner is not
// hive's CLI, its MCP server, or its hooks, so HIVE_ALLOW_DEFAULT_STORE is
// the deliberate opt-in that makes this the human case rather than the
// step-11-driver case those five paths exist to catch.
```

## line 47

```
// Naming the default explicitly is still the default, not a third store.
```

## line 49

```
// And the pure half, in this process: an empty tag is what makes that
// name. tagFor takes the directory, so a caller that genuinely means the
// default store can say so without being handed one it may not use.
```

## line 56

```
// The gap e0d6be5 left. isDefaultStore() taught storeDir/guardStoreDir and
// untrustedTmuxServer to follow symlinks, but tagFor kept comparing
// strings, and sessionName reaches tagFor through dataDirTag. So
// HIVE_DATA_DIR symlinked at ~/.hive produced a hash-tagged name for the
// same store that hive-main names under the literal path.
//
// That is not cosmetic. A session name is the target argument for
// kill-session and respawn-pane, which is the whole reason dataDirTag was
// pulled behind the guard in the first place. One store answering to two
// names means agent_close aims at hive-main while the workers live under
// <hash>-main: workers you cannot reach and a session you cannot kill.
//
// Safe to run: dist/tmux.js imports dist/dataDir.js and nothing else, so
// resolving a NAME opens no database. If tmux.ts ever gains a db import,
// this case has to be rethought.
```

## line 78

```
// The pure half, in this process. tagFor still takes a directory, so a
// caller naming one gets an answer about that directory; it just answers
// about where the directory IS rather than how it is spelled.
```

## line 88

```
// The half the default-store case cannot show. The hash takes the
// canonical path, not just the comparison, so the rule is one rule: two
// spellings of one store share a namespace wherever that store is. Without
// it the identical split happens one store further out, and the failure is
// the same one - a project answering to two session names.
```

## line 107

```
// The hole this closes. A session name is the target argument for
// kill-session and respawn-pane, so an unisolated test asking for
// sessionName() used to get "hive-main" -- the live, shared session of the
// default store -- and agent_close would have killed it with every real
// project's workers inside. Refusing costs a test nothing: every test that
// names a session already sets HIVE_DATA_DIR.
```

## line 128

```
// Every store's one session is named main, so without this a scratch
// instance resolves to the live, shared session of the default store --
// which is how a test run once split panes into a live lead window.
```

## line 151

```
// tmux.js must not pull in db.js: importing it would create and migrate a
// store as a side effect, including in tests that only inspect names.
```

## line 165

```
// The half the subprocess cases cannot see. dataDirTag used to be a
// module-level const, so a process that imported tmux.js before setting
// HIVE_DATA_DIR kept naming sessions after the store it no longer used.
// Two names from ONE process, either side of the assignment. Run as a
// human, because "before" is the default store and hive will not name that
// one for a test runner.
```
