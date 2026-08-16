# Attic: test/tmux-kill-guard.test.mjs

Comments removed from `test/tmux-kill-guard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 11

```
// Todo 417. No store, no tmux, no network -- classify() is pure and the
// wrapper/wiring checks below only spawn the guard script itself or read
// committed JSON, so this file needs none of test/CLAUDE.md's isolation
// machinery (isolateTmux, scratch dirs).
```

## line 84

```
// Review round 1 (todo 417 comment 1101), finding 1, BLOCKING: an earlier
// line's own -S used to vouch for a later bare kill-server in the same
// multi-line Bash-tool command, because splitSegments() only split on
// [;&|] and a newline-joined debug block is one string with no such
// character in it. This is the incident's own shape -- the fatal command
// was the LAST line of a block whose earlier lines were already tmux calls.
```

## line 107

```
// Review round 1, finding 2, BLOCKING: TMUX_INVOCATION_RE required tmux to
// be preceded by whitespace or a segment boundary, so a quote hid the
// invocation from it entirely -- the exact bypass the original todo
// predicted ("a bare 'denied' earns a retry with `sh -c`").
```

## line 125

```
// A quote hiding the INVOCATION must still deny; a quote hiding only the
// -S FLAG must still allow -- the fix is symmetric, not one-directional.
```

## line 133

```
// Review round 1, finding 3, SHOULD FIX: EXPLICIT_S_RE used to test the
// whole segment, so an -S belonging to something else entirely -- here, an
// env-var VALUE that happens to spell "-S", sitting before the tmux
// invocation even starts -- vouched for the kill. Scoping the check to the
// tmux invocation's own span (from where "tmux" starts onward) closes this
// without needing a real shell parser.
```

## line 141

```
// A prior command's own -S flag, whitespace-bounded and genuinely
// matchable by EXPLICIT_S_RE, sitting BEFORE the tmux invocation in the
// same segment. Scoping the check to the invocation's own span (from
// where "tmux" starts onward) is what tells these apart; a whole-segment
// check cannot, because to a whole-segment regex an -S anywhere in the
// string looks identical regardless of which command it belongs to.
```

## line 160

```
// The wrapper is what Claude Code actually invokes. Exercising classify()
// alone would not catch a wrapper that classifies correctly but emits the
// wrong protocol (todo 417 step 1a measured exit-code-2 + stderr as the
// shape this installed Claude Code honours), or that forgets to print the
// safe form the denial message is supposed to lead with.
```

## line 196

```
// Review round 2 (todo 417 comment 1103): measured live that TMUX_TMPDIR
// cannot protect a worker at all from inside a tmux pane, even when the
// directory it names exists -- $TMUX overrides it outright. Only -S
// overrides $TMUX. The denial message used to explain only the
// directory-fallback failure mode, which reads as "keep the directory
// alive and you're fine" -- false for every hive worker, which always
// runs inside a pane.
```

## line 236

```
// Pins that the hook stays wired into THIS repo's tracked settings, not
// only that the script itself classifies correctly -- a future edit that
// unwires the hook (renames the matcher, points the command elsewhere,
// deletes the block) would leave classify()'s own tests green while the
// guard stopped firing for real.
```
