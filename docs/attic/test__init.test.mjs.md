# Attic: test/init.test.mjs

Comments removed from `test/init.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
```

## line 11

```
// runCli never has a TTY, which is also the non-interactive path hive init
// has to handle without prompting and without failing.
```

## line 20

```
// Todo 323 audit (generated-data assertions). `hive init` unconditionally
// prints `Project: ${project.name} (${project.path})` as its first line
// (src/cli.ts, cmdInit), and both project.name and project.path are built
// from scratchDirs()'s mkdtempSync() calls (helpers.mjs), so `stdout` below
// genuinely can carry generated data. The `/ln -s/` doesNotMatch checks
// further down are safe anyway only because mkdtempSync's random
// six-character suffix is drawn from [0-9a-zA-Z] and can never contain a
// space: a pattern requiring one (like the literal space in "ln -s") cannot
// be satisfied by the random segment alone, whatever it happens to spell.
```

## line 35

```
// With a profile the process lives in `hive runbook`; a runbook pad would
// be a second source of truth nobody updates.
```

## line 45

```
// The plugin is one symlink per machine, so these cases turn on what is in
// the home directory, not on the project. HOME points at a scratch dir:
// the real ~/.claude must not decide whether a test passes, and hive must
// never touch it.
```

## line 69

```
// The second project on a machine should not be told to install what the
// first one already installed.
```

## line 81

```
// Two clones, one symlink: sessions run the OTHER checkout's kickoff,
// which is invisible until you notice the wrong code ran.
```

## line 95

```
// Claude Code relocates its whole state tree, plugins included, when
// CLAUDE_CONFIG_DIR is set. Reading ~/.claude regardless would report "not
// installed" to someone who has installed it, and hand them a command that
// links it where their claude never looks.
```

## line 103

```
// ~/.claude stays empty, so a homedir()-only implementation says "missing".
```

## line 114

```
// The install line has to be pasteable. "~/.claude/skills/hive" is a lie
// when claude is reading somewhere else.
```

## line 157

```
// The project still parses, with both the old keys and the new one.
```
