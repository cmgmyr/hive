# Attic: test/notified-at-discriminator.test.mjs

Comments removed from `test/notified-at-discriminator.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 7

```
// Todo 415, filed from todo 386's teardown. wake_idle_notices.notified_at is
// declared DEFAULT (datetime('now')) in src/db.ts and claimEpisode's INSERT
// never names it, so a claim row carries the moment it was WRITTEN. No writer
// touches it on update - stampEpisodeNotice (src/scheduler.ts) sets
// notice_timer_id and nothing else, and rearmSpentEpisode DELETEs rather than
// clearing. That is the ONLY thing that told a re-inserted claim from an
// updated one in todo 386's own diagnosis (src/scheduler.ts's comment above
// claimEpisode has the worked example), and nothing pinned it before this.
//
// Both functions are private to src/scheduler.ts and unreachable directly, so
// both tests below drive the real thing through tick(), the same method
// test/standing-watch.test.mjs established.
//
// A NOTE ON THE TWO MUTATIONS THE TODO NAMES, measured rather than assumed.
// stampEpisodeNotice's own comment says it "only ever stamps episodes a
// single batch just claimed", and standingIdleRows'/standingGoneRows'
// unreported() read-gate makes that airtight: a candidate reaches
// claimStandingBatch only when no unspent claim already exists for it, so in
// every reachable call claimEpisode's INSERT and stampEpisodeNotice's UPDATE
// run on the SAME just-inserted row, microseconds apart, inside one
// transaction. Verified by mutation: adding `notified_at = datetime('now')`
// to stampEpisodeNotice's own SET clause, in isolation, is INERT against
// every scenario reachable this way - the value it would write is
// byte-identical to what the immediately-preceding INSERT already wrote, so
// no assertion at whole-second resolution can tell the two apart. That
// mutation only becomes observable paired with a second one that makes
// claimEpisode's own INSERT touch an EXISTING row without deleting it first
// (an upsert replacing the delete-then-insert pattern) - which is exactly
// the danger the todo's "makes a re-claim indistinguishable from a stamp"
// describes, and is what the first test below mutates and kills. The second
// test below finds the reachable form of "stamping for freshness": not
// stampEpisodeNotice's own SET clause, but a companion write that refreshes
// every row a coalesced notice carries rather than only the row this tick
// actually claimed.
```

## line 51

```
// One project, one lead whose pane is dead (absent from the snapshot), and
// helpers to add crew - the identical shape test/standing-watch.test.mjs
// uses. The dead lead pane matters here for the same reason it does there:
// a filed notice is a real due-now timer, and deliverable() HOLDS a
// lead-owned wake whose pane is not live rather than typing it or cancelling
// it - so fired_at stays NULL forever on its own, and the tests below can
// force it to a "spent" value by hand without a real delivery ever racing
// them.
```

## line 93

```
// The lead's own pane is deliberately absent, matching standing-watch.test.mjs.
```

## line 103

```
// A whole-second clock is the trap named in the todo and in
// .claude/sessions/dead-ends/2026-08-09-comparing-a-whole-second-episode-
// against-a-millisecond-log-row.md: a claim and a later touch in the same
// wall second are byte-identical, so every fixture below backdates the
// FIRST claim far enough (45 minutes, matching pad 142's own scenario and
// the existing "keeps the hold's own start time separate" fixture in
// test/standing-watch.test.mjs) that a real re-write can never be mistaken
// for luck.
```
