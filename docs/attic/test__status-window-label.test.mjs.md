# Attic: test/status-window-label.test.mjs

Comments removed from `test/status-window-label.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// Todo 272 / plan-lane-3-tmux-topology. Found by the lead by RUNNING the
// command, not by the suite: under one store-scoped session (3a),
// `hive status` printed the IDENTICAL `session: hive-<tag>main` for every
// project - before 3a it printed hive-1 / hive-12, which identified the
// project, so this was correct and useless. The window now identifies a
// project (@hive-project-id, findProjectWindow); this pins that `hive
// status` actually prints it.
```

## line 33

```
// Any open todo is enough to keep this project's line printing (cmdStatus
// skips a project with zero agents, zero todos and zero timers).
```

## line 50

```
// Todo 323 audit. `hive status` prints project.path (a real
// mkdtempSync() scratch path, see scratchDirs() in helpers.mjs)
// elsewhere in this same stdout, so the haystack here genuinely can
// carry generated data. This needle is immune anyway: it is built
// from `session`, this SAME process's own real, already-computed
// session name, not a generic pattern - so it can only ever match the
// literal old-format line it names, never an unrelated scratch path.
```

## line 67

```
// A project can carry open todos with no tmux session ever created
// (the lead never started) - the common case for a freshly registered
// project. findProjectWindow throws ("can't find session") against a
// session that does not exist; this must not take `hive status` down
// with it.
```

## line 79

```
// Todo 274/275 addendum (topology-3c). sessionName() is invariant across the
// whole process (one store-scoped session), so forking `tmux list-windows`
// once PER PROJECT inside cmdStatus's loop forks the identical listing
// every time - cmdStatus now fetches it once, lazily, and matches each
// project against the shared result (the same pattern cmdDoctor's own
// hiveSessions() already uses). Proven here against the REAL binary, not a
// canned stub: a passthrough `tmux` shim on PATH logs only `list-windows`
// invocations and then execs the real tmux with the identical argv, so this
// cannot pass by coincidence of a mocked answer - the command actually runs.
```

## line 114

```
// The REAL PATH, captured before the shim goes in front of it, so the
// shim's own `exec tmux` resolves to the genuine binary rather than
// recursing into itself.
```

## line 135

```
// Correctness, not just the fork count: both projects must still
// resolve their OWN real window, proving the shared fetch was matched
// per project rather than one project's answer leaking into the other.
```

## line 158

```
// Review gate on PR #116 (the ubuntu legs' first real pass, 10m44s, one
// finding - not the 15-second no-op this repo has seen twice before). The
// window-label comment above named "no tmux binary" as a path to the
// distinct "unknown (tmux unreachable)" label; it is not - tmuxSaysNothingThere()
// returns true for e.notInstalled by design (src/tmux.ts), so a missing
// binary takes the SAME "none yet" branch as "the lead never started". The
// comment is now corrected to say so; this pins the behaviour it claims,
// which nothing in the suite covered before this.
//
// test/CLAUDE.md's own guidance ("run the suite with a PATH that lacks
// [installed binaries]") is the precedent for simulating this - applied
// here to one subprocess rather than the whole run, by filtering tmux's
// directory out of PATH rather than replacing PATH wholesale, so `node`
// itself (runCli spawns it by bare name) and everything else `hive status`
// might touch stay resolvable.
```

## line 193

```
// Todo 323 audit. Same haystack concern as the /session: ${session}/
// check above: stdout also carries project.path (a real mkdtempSync()
// scratch path). This pattern is immune because it requires a literal
// space and parenthesis ("unknown (tmux unreachable)"), and mkdtempSync's
// random alnum suffix can never contain either.
```
