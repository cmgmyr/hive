# Attic: test/cli.test.mjs

Comments removed from `test/cli.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 8

```
// runCli spawns hive, whose commands probe tmux; isolate first (see helpers.mjs).
```

## line 12

```
// End to end through the built CLI: init seeds the runbook pad, then the
// pads/pad commands cover print, edit export, save, and conflict handling.
// HIVE_EDITOR=true (set in runCli) keeps any real editor from opening.
```

## line 77

```
// Issue #27, step 5: the "N agents" count has always filtered kind='agent',
// and this confirms that filter also excludes the lead's own row now that
// one exists, rather than assuming it. Zero production code changes here -
// this is the test that goes red if a future change widens the filter.
```

## line 105

```
// A single tool call is enough to register a directory as a project.
```

## line 126

```
// A concurrent session bumps the pad while the human edits.
```
