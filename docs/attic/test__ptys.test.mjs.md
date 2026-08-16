# Attic: test/ptys.test.mjs

Comments removed from `test/ptys.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 16

```
// `hive doctor` runs the janitor, which reaches tmux (test/CLAUDE.md).
```

## line 19

```
// Captured shape, not a real `ps` run: test/CLAUDE.md's "a test asserting a
// number read off the box it runs on cannot fail" applies here exactly as it
// does anywhere else in this suite, and it is the precise defect this
// module exists to avoid repeating
// (.claude/sessions/dead-ends/2026-08-07-pgrep-x-zsh-to-count-shells-holding-ptys.md).
// Row count (7), allocated tty count (5) and orphan count (3) are all
// different numbers, so a probe that reads the wrong field cannot pass by
// accident.
```

## line 28

```
// live login shell, allocated
// same tty as above -- allocated must count ttys, not rows
// orphan: leading dash, ppid 1
// orphan: a different shell, same leading-dash rule
// ppid 1 but no tty and no leading dash: neither allocated nor orphan
// allocated, not orphan: no leading dash despite a live pane
// orphan: leading dash survives a full path, matched on the basename
```

## line 64

```
// This is the exact trap the dead-end names: matching the full string
// "-zsh" rather than the basename, or requiring an exact "zsh" name,
// would both undercount here.
```

## line 88

```
// max 511 -> threshold 51. free == 51 when allocated == 460.
```

## line 93

```
// free == 50.
```

## line 98

```
// free == 52.
```

## line 103

```
// max 100 -> 10% would be 10, but the floor of 32 wins.
// free 32
// free 31
```

## line 128

```
// Stands in for a missing sysctl or an unreadable /proc file -- the
// point under test is that a thrown probe never reaches the caller as
// a thrown error, not which real-world probe failed.
```

## line 140

```
// Counselors review (codex-5.6-sol-high): every test above asserts parsing
// and comparison logic against fixtures, per design -- a test asserting a
// number read off the box it runs on cannot fail (test/CLAUDE.md) -- but
// nothing exercised the real darwin/linux probe or cmdDoctor's own wiring,
// so a misspelled sysctl name, a wrong /proc path, or deleting
// `reportPtyHeadroom();` from cmdDoctor would leave every test above green.
// This closes that gap without asserting a live number: only the LABEL's
// presence and shape are pinned, on the platforms hive actually ships CI for
// (CLAUDE.md: "CI runs the same on macOS"; linux is the other supported
// platform per src/ptys.ts's own probeForPlatform).
```

## line 161

```
// "in use", not "allocated": on darwin the number is ttys with a live
// process, a lower bound on the kernel's allocation rather than the
// allocation itself (src/ptys.ts, PtyHeadroom.allocated). Pinning the
// honest word here keeps a future edit from quietly restoring the
// stronger claim in doctor's own output.
```
