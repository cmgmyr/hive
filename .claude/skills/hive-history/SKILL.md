---
name: hive-history
description: Historical rationale for hive's internals - why a guard, a bound, an ordering or a workaround in src/ is the way it is. Search this before re-deriving a tmux, SQLite, Claude Code or scheduler fact, before "simplifying" something that looks arbitrary, and when a change to src/ has no obvious reason not to be safe. Temporary: this is the attic of comments stripped from src/ in todo 436, and it will be deleted once what mattered has been promoted out of it.
---

# hive's attic

`docs/attic/` holds every comment removed from `src/` at fed8064, verbatim, one file per source file with pre-strip line numbers. 16,030 lines of it. It is accurate; the only edits made to it are the `PROMOTED:` notes described below.

## Finding something

One file per source file, named for it:

```
grep -rn "unref" docs/attic/                    # by topic, across everything
cat docs/attic/src__scheduler.ts.md              # everything about one file
```

## Then promote what you found

Check `.claude/skills/hive-internals/references/` first - most tmux, store-and-datadir, and worker-state prose here is already promoted there from todo 437, and re-promoting it into a file it already lives in wastes the trip.

**Looking something up here is the signal that it was worth keeping.** Do not use it and move on - that leaves the next person to find it again. Give it a permanent home, by who needs it and when:

| what it is | where it goes |
|---|---|
| a prohibition spanning files, that nobody would think to ask about | `.claude/rules/` |
| evidence, mechanism, or a measurement expensive to re-derive | the `hive-internals` skill's references |
| a standing lesson about how work runs here | the `lessons` pad |
| why one lane decided something | a todo comment |
| a gotcha the next person editing that exact line needs | a code comment, one or two lines |

Then add a line at the top of that attic file - `PROMOTED: <destination path>, <date>` - so nobody promotes it twice.

Anything nobody ever looks up gets deleted with the attic. Never having been consulted is the measurement that it was not needed.
