# Attic: src/transcript.ts

Comments removed from `src/transcript.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 5

```
// Claude Code's own project-transcript encoding (issue #5), reverse-engineered
// against real directories under ~/.claude/projects rather than assumed:
// every `/` and every `.` in the absolute cwd becomes `-`. `/.claude` in a
// worktree path is therefore two dashes, one per character, not one merged
// separator. This is a private convention of Claude Code, not a documented
// API -- resolveTranscriptDir below is what keeps that honest.
```

## line 19

```
// A heuristic that admits it, and admits it precisely. The stat below
// proves only "a directory by this name exists", not "this is that worker's
// transcript" -- the encoding is not injective, since both `/` and `.`
// collapse to the same `-`, so "/a/b.c" and "/a/b/c" both encode to
// "-a-b-c". A stat cannot tell a directory that exists for a colliding cwd
// from one that exists for this one; nothing on hive's side can, since the
// encoding belongs to Claude Code and hive only reads it. What this function
// CAN rule out, and the only thing it claims, is the absent case: null means
// nothing was ever written under this name.
```
