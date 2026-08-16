# Attic: test/project-registration-race.test.mjs

Comments removed from `test/project-registration-race.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 6

```
// Issue #148 / todo 345. addProject used to be SELECT-then-INSERT: two
// sessions resolving the same unseen checkout at once could both find
// nothing, then both INSERT, and the loser hit projects.path's UNIQUE
// constraint and threw even though the project now exists, correctly, under
// the winner's row.
//
// Unlike the pad and lease races, this window is NOT sub-microsecond. The
// SELECT that used to decide "nothing here yet" ran near the top of the old
// function, well before any competing process could have committed its own
// INSERT, so real concurrent processes land inside it reliably rather than
// by luck. This test races real processes instead of asserting the SQL
// directly, matching this suite's own precedent
// (test/attach-view-race.test.mjs) for a race wide enough to actually hit.
//
// PROVEN RED against the pre-fix SELECT-then-INSERT: at least one of six
// racing processes threw a UNIQUE constraint error instead of returning a
// project. Output pasted in the PR body.
```
