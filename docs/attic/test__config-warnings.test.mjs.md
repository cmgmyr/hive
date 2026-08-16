# Attic: test/config-warnings.test.mjs

Comments removed from `test/config-warnings.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 16

```
// A malformed hive.yml must reach the caller that can act on it. `hive lead`
// and `hive start` already print loadProjectYml's warnings; these cover the two
// paths that used to swallow them: the agent_spawn receipt and hive doctor.
```

## line 20

```
// agent_spawn creates a real tmux session, so this suite needs a private one.
```

## line 24

```
// sessionName tags itself from HIVE_DATA_DIR, so the test process has to
// resolve the same store the server does to name the session it must clean up.
```

## line 50

```
// `sleep` instead of claude: the receipt shape under test is the same, and
// the spawn does not have to wait on a real TUI coming up.
//
// The argument goes in extra_args, NOT in the command string. workerCommandString
// shellQuotes `command` as a single token so a claude path containing a space
// survives, which turns "sleep 600" into '600'-is-part-of-the-name and the pane
// dies with "command not found" before it has drawn anything.
```

## line 93

```
// doctor fails on a missing claude or tmux, which says nothing about this
// change. Compare the counts the summary line carries, across runs, instead
// of the exit code.
```

## line 97

```
// One doctor run per config state, shared by the assertions about it.
```

## line 110

```
// Immune: noYml.stdout does carry generated scratch paths (dataDir,
// hooksPath, etc. printed by other doctor checks), but mkdtemp's random
// path segments are plain alnum with no "." in them, so the literal,
// period-bearing "hive.yml" can never appear inside one by coincidence.
```

## line 122

```
// The PROBLEM count, not the whole summary line: todo 292 put the warn
// count on that line as well, so the line legitimately differs between
// these two runs - by the warning this test is about - while the claim
// being made is only about the problem count.
```

## line 127

```
// Without this, the equality above is vacuous if the malformed hive.yml
// somehow produced no warning at all.
```

## line 135

```
// Immune, same reason as the "no hive.yml" case above: no generated path
// segment in this suite ever contains a literal ".", so nothing but a
// real warn("hive.yml", ...) call can produce this substring.
```
