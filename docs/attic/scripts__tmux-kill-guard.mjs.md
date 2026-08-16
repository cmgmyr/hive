# Attic: scripts/tmux-kill-guard.mjs

Comments removed from `scripts/tmux-kill-guard.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 2

```
// Todo 417: a repo-local PreToolUse guard, wired from THIS REPO's
// .claude/settings.json, not from src/hooks.ts / ~/.hive/hooks.json. It
// protects agents developing hive itself, not hive's shipped users -- see
// todo 417 comment 1092 for why that boundary matters.
//
// LIMITS, stated honestly because the next reader will otherwise over-trust
// this: this guards the Bash TOOL, not the machine. It does not see a kill
// inside a shell script file, a `$(printf tmux)` construction, or a node
// child_process call. It stops a model typing the obvious command --
// `tmux kill-server` with no `-S` -- because that is the failure that has
// actually happened here, twice in one hour
// (.claude/sessions/dead-ends/2026-08-14-kill-server-as-a-tidy-up-step.md).
// That is the whole claim.
//
// classify() is exported and pure so the suite can drive it directly; main()
// below is the thin stdin/stdout PreToolUse wrapper around it.
//
// MEASURED, todo 417 review round 2 (comment 1103), from inside a live hive
// pane: TMUX_TMPDIR cannot protect a worker at all, even when the directory
// it names exists and is reachable, because $TMUX -- set inside every
// tmux pane -- overrides it outright; a client resolves its socket from
// $TMUX first. -S DOES override $TMUX: `tmux -S <path> ...` reached only
// the named socket while an ambient, TMUX_TMPDIR-only call in the same
// shell still reached the shared server. So -S is not merely the
// documented-safe form, it is the ONLY form that is safe from inside a
// pane, which is where every hive worker runs.
```

## line 33

```
// Segment on unquoted shell control operators AND newlines, same approach
// as the existing global git-push guard
// (~/.claude/hooks/block-git-commands.sh) extended to cover a multi-line
// Bash-tool command: a debug block is one string with embedded "\n"s, not
// several commands, and review round 1 (todo 417 comment 1101) found that
// splitting on [;&|] alone left a multi-line block as ONE segment, so an
// earlier line's own -S vouched for a later bare kill-server -- exactly the
// incident's own shape (dead-ends/2026-08-14-kill-server-as-a-tidy-up-step.md:
// the fatal command was the LAST line of a block whose earlier lines were
// already tmux calls). Over-splitting inside a quoted string can only
// produce SMALLER segments, and a real `tmux ... kill-server` keeps its own
// arguments together regardless. Judging one segment at a time is what lets
// `tmux -S "$TMUX_TMPDIR/tmux-$(id -u)/default" kill-server; rm -rf "$DIR"`
// pass while `some-setup && tmux kill-server` still denies.
```

## line 51

```
// \b (a transition between a word char and a non-word char, or string
// start/end) is what makes this quote-blind: a quote, like whitespace or a
// segment operator, is a non-word character, so `\btmux\b` matches the
// "tmux" in `sh -c "tmux kill-server"` exactly as it would unquoted. Review
// round 1 found the PREVIOUS version denied via an explicit boundary
// character class ([\s;&|]) that did not include quotes, so a quote before
// "tmux" hid the invocation from it -- the exact bypass the todo predicted
// in advance ("a bare 'denied' earns a retry with `sh -c`"). Do not try to
// parse the shell to close this properly; a word boundary is the honest,
// cheap version of "a quote should not hide a command word" and nothing more.
```

## line 63

```
// Same quote-as-boundary reasoning as above, applied to the flag itself:
// `(^|[\s'"` + "`" + `])` treats a quote exactly like whitespace or the
// string start, so `"-S"` is recognised as the flag rather than hidden text.
```

## line 83

```
// Scope kill-server/-S detection to THIS invocation's own span -- from
// where "tmux" itself starts to the end of the segment -- rather than
// the whole segment. Review round 1 found the whole-segment version let
// an unrelated -S earlier in the same segment (a different command's
// flag, an env-var value) vouch for a kill it had nothing to do with.
// Ask whether the invocation that carries kill-server has an -S, not
// whether the text around it does.
```
