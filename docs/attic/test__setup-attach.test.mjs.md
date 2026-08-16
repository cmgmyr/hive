# Attic: test/setup-attach.test.mjs

Comments removed from `test/setup-attach.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// hive doctor runs the janitor, which probes tmux; isolate before any test
// in this file runs, even the ones that only call setup. Nothing here creates
// a session, so there is nothing to name and kill; only the socket dir needs
// removing on exit.
```

## line 97

```
// helpers default this legacy override to 0 to prevent native windows;
// an unknown value is deliberately absent and lets config discriminate.
```

## line 112

```
// IMMUNE to generated data: doctor.stdout also carries this run's scratch
// dataDir/projectDir path, but mkdtemp's random suffix is alnum-only, so
// it can never spell a hyphenated, multi-word literal like
// "allow-passthrough" or "pane-border-status" by accident. Those two
// strings are only ever printed by doctor's raw-attach-options report
// (src/cli.ts, inside `if (mode === "raw")`), which this case never
// reaches because no tmux server is up. Same reasoning applies to the two
// doesNotMatch calls below in this describe block.
```

## line 132

```
// IMMUNE, same reasoning as above.
```

## line 169

```
// IMMUNE, same reasoning as the first case in this describe block above.
```
