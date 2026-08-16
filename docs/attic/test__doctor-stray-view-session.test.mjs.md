# Attic: test/doctor-stray-view-session.test.mjs

Comments removed from `test/doctor-stray-view-session.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Todo 273 / pad 76 "VIEW SESSIONS DESIGNED AND SETTLED WITH CHRIS", point 7,
// Chris's call: doctor REPORTS a stray (clientless) view session and never
// kills one - destroy-unattached (set on every view at creation) should
// already make one unreachable the instant its client detaches, so this is
// belt-and-braces, not a sweep. The suggested removal command MUST be quoted:
// a bare leading `=` in a command a human pastes into zsh triggers EQUALS
// EXPANSION (.claude/rules/tmux-and-panes.md, "Two shell traps").
```

## line 31

```
// Mirrors view-session.test.mjs's own attachClient: a headless control-mode
// client registers as a real client (visible in list-clients) with nothing
// more than PATH and stdio, no pty required - measured against tmux 3.7b.
```

## line 56

```
// Created with -d (never attached), so it starts with zero clients -
// the same end state a real view session reaches if destroy-unattached
// somehow failed to fire on a client's detach. Grouped with base
// (`-t =base`), the same relationship a real view session has.
```

## line 72

```
// The exact printed string, quotes included - a human pastes this
// verbatim, and an unquoted leading `=` is broken advice in the exact
// shell this project runs in.
```

## line 117

```
// IMMUNE to generated data: out.stdout also carries this run's scratch
// project path and its real session/view names (sessionName(),
// viewSessionName()), but none of those can ever spell the literal
// "view session" (two words joined by a space) - tmux session names are
// built from SESSION_PREFIX + dataDirTag() + a suffix, all alnum/hyphen,
// and dataDirTag() hashes the data dir rather than embedding it, so no
// generated name here can ever contain a space. The only place doctor
// prints this exact two-word literal is the stray-view warn() call
// (src/cli.ts, `warn("view session", ...)`), which this case's setup
// never triggers.
```
