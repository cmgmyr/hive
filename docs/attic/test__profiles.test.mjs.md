# Attic: test/profiles.test.mjs

Comments removed from `test/profiles.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
```

## line 12

```
// profiles.js reads HIVE_DATA_DIR when asked rather than at import time, so
// this only has to be set before a profile path is resolved. Set here anyway:
// storeDir() refuses the real store under a test runner, and every case below
// wants this scratch one.
```

## line 58

```
// The files not overridden keep tracking hive's defaults.
```

## line 69

```
// hive.yml is repo-controlled and posture.md becomes a system prompt.
```

## line 94

```
// profileStatus compares the shipped file against the hash recorded at
// fork time; the fork itself is never touched.
```

## line 109

```
// Own data dir, isolated from `scratch`: forking "orchestration" here would
// otherwise shadow the shipped runbook.md/worker.md content that later
// describe blocks in this file read back (e.g. "renders hive's shipped
// runbook without leaving markers behind"), since resolution is per-file
// copy-on-write and HIVE_DATA_DIR is read at call time, not import time.
```

## line 220

```
// A runbook missing a value should look wrong, not read as though it had
// one. `hive doctor` reports the same gap.
```

## line 246

```
// Todo 332. Pure-function level: the four high-confidence shapes doctor
// scans for, and the false-positive traps found measuring this detector
// against the real orchestration fork at ~/.hive/profiles/orchestration
// (recorded in the PR body and in profiles.ts's own comment above
// referencedPaths).
```

## line 264

```
// The orchestration fork's own worker.md documents the CLI this way:
// a literal `<name>` describing the syntax, not a real pad. `<` is not
// a name character, so the match never starts.
```

## line 271

```
// profiles/orchestration/worker.md: `hive pad --save <file>` for a large
// pad. The flag comes first here, not a name.
```

## line 298

```
// .claude/sessions/ is established one sentence earlier in the real
// fork's runbook.md; `working-on.md` alone means the file in that
// directory, not one at the project root. See referencedPaths's own
// comment in profiles.ts for the measurement this narrowed on.
```

## line 322

```
// Absent means "never asked", so hive init may offer the prompt; none is
// a decision hive must not re-litigate.
```

## line 357

```
// vars declared in hive.yml render with no approval step. They reach a
// system prompt, which is a deliberate trade recorded in CLAUDE.md: hive
// gates what it EXECUTES, not what it quotes into a prompt.
```

## line 366

```
// Through the real path: --no-profile is what writes the key AND seeds
// the pad, so a project on none always has something to print.
```

## line 388

```
// Own scratch, isolated from `dirs`: a later test in this describe
// ("forks into the data dir...") forks orchestration/posture.md into
// `dirs.dataDir` itself and asserts on the CLI's "forked posture.md"
// wording, which this must not race or pre-empt.
```

## line 399

```
// upstreamMoved also requires an origin recorded at fork time that no
// longer matches hive's current shipped hash; a bogus one stands in
// (same fixture shape as "reports when hive's default moved after a
// fork" above).
```

## line 412

```
// Identical sentence to what `hive doctor` prints for the same file and
// the same fork - see the "profile divergence: warn survives small
// drift, info replaces a rewrite" describe in doctor-profile.test.mjs.
```

## line 429

```
// posture.md is delivered by path, so `hive lead` writes the rendered
// text to a generated file. Without this command there is no way to see
// what the lead is actually running with: `hive profile path` shows the
// unrendered source.
```
