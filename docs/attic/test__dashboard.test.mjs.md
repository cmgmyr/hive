# Attic: test/dashboard.test.mjs

Comments removed from `test/dashboard.test.mjs` by todo 438, verbatim. Line numbers are
positions in the pre-strip file at 67c76c2.

## line 9

```
// Step 1 of the dashboard lane (todo 308): renderDashboard() is pure - no
// tmux, no filesystem, no scheduler - so this file needs neither isolateTmux
// (nothing here can reach a tmux server; see test/suite-isolation.test.mjs's
// own REACHES_TMUX list) nor a spawned process per case. One store, imported
// once, reused across every test in this file.
//
// Step 2 (todo 309) added tick() itself, which CAN reach tmux - but only
// when it has a due timer to deliver. Every test below that calls tick()
// seeds zero timers and always passes tick(null) explicitly ("liveness is
// unknown, do not ask" - src/scheduler.ts's own comment on tick's snapshot
// parameter), never bare tick(), so no test in this file ever forks a real
// tmux process. Keep both of those true for any test added here later, or
// this file needs isolateTmux() after all.
```

## line 27

```
// Forced rather than left to whatever the runner's default is (CI images are
// typically UTC, which would make a local-vs-UTC bucketing bug invisible: on
// a UTC box, local IS UTC, so a broken implementation and a correct one
// would agree on every day boundary). America/New_York is UTC-4/-5, matching
// Chris's own report of the bug ("this box is UTC-4"), and a non-zero offset
// is what lets the boundary test below actually distinguish correct from
// broken. Measured directly, not assumed: mutating process.env.TZ
// mid-process changes what better-sqlite3's own 'localtime' modifier reports
// on the very next query, so setting it here (before the dist modules below
// ever touch the database) is sufficient - no need to set it in the shell.
// node:test isolates each file into its own process, so this cannot leak
// into any other test file.
```

## line 55

```
// The exact UTC instant that corresponds to a given LOCAL calendar day, N
// days before today, at a given local time of day. Computed entirely inside
// SQLite (the 'localtime'/'utc' modifiers), never via JS Date arithmetic, so
// the day boundary a fixture is seeded against and the day boundary the code
// under test computes both come from the identical clock - see
// fetchDayStats's own comment in src/dashboard.ts for why that matters.
```

## line 67

```
// A minimal fake-DOM harness for the Live toggle's client-side SCRIPT. This
// file has no real browser, so extracting the script's source text and
// asserting on its STRING CONTENT (as the section-persistence tests below
// already do, e.g. "the script must select details[id]") proves the code is
// present, never that it BEHAVES correctly - not enough for something this
// stateful (a toggle whose whole job is arming/disarming a timer based on
// stored state). This harness instead EXECUTES the real, extracted script
// against fake document/window/sessionStorage/setTimeout objects and
// observes real outcomes: was a timer armed, what got persisted, what the
// checkbox and stamp end up showing. Deliberately narrow - it does not
// simulate <details> elements at all (document.querySelectorAll returns an
// empty array), because the details-restore behavior is already covered
// elsewhere and this harness exists specifically for the toggle.
```

## line 138

```
// any truthy, distinct id is fine - never awaited for real
```

## line 147

```
// Runs the REAL extracted script text (not a reimplementation) with the
// browser globals it references shadowed by the fakes above - a standard
// sandboxing technique: `new Function` parameters shadow the identically-
// named ambient globals for everything inside the function body.
```

## line 191

```
// awaitingFirstPrompt stamps agents.resumed_at, which src/firstPrompt.ts reads
// as "started, and not yet given anything" - what launchAgent writes at every
// spawn and resumeAgent at every resume, cleared by the worker's first real
// prompt. Seeded rather than driven here because renderDashboard is a pure
// reader; the end-to-end path through a real spawn and real hooks is
// test/spawn-false-finish.test.mjs's.
```

## line 217

```
// UTC -> the same local formatting renderDashboard uses, computed
// independently (not by re-reading dashboard.ts's own function) so this is a
// real check of the derived value, not a tautology.
```

## line 235

```
// Escaped, not raw: ">" becomes "&gt;" so the pad's own markup can never
// be mistaken for the dashboard's, but a browser renders the escaped form
// right back to ">>>" visually, so this is the content surviving, not it
// being altered.
```

## line 270

```
// Queue order: high-priority todos (blocker, blocked, high) all precede
// the low-priority one, because priority sorts before id.
```

## line 278

```
// Visual distinctness (todo 333): the badge carries the LIFECYCLE status
// word (both rows are "open" here), not a "blocked"/"open" word of its
// own - that word belonged to the status column and duplicating it is
// the bug 333 filed. Blockedness shows through the badge's color (warn)
// and the "blocked by #N" line, which stays visible unconditionally.
```

## line 348

```
// The row's SUMMARY (badge/priority/id/slug, collapsed by default) must
// carry fallbackSlug's own truncation, not the bare 80-char title - the
// full title is still on the page, deliberately, inside the expander
// this same row's body renders, so an "absent anywhere" check would be
// wrong: the point is where each form appears, not whether the long
// form exists at all.
```

## line 402

```
// 22:00 local yesterday. This file forces TZ=America/New_York (UTC-4/-5),
// so 22:00 plus that offset always lands past midnight UTC - the exact
// shape from the bug report ("work done after 20:00 local lands on the
// next UTC day"). A UTC-day bucketing bug would count this as completed
// TODAY; correct local-day bucketing counts it as completed YESTERDAY.
```

## line 481

```
// Visual redesign: "working" now carries the "live" status word (hive's
// own vocabulary for "currently running", the same accent a pending
// wake gets) rather than a bespoke colored state badge.
```

## line 491

```
// src/hook.ts's agent_state UPDATE is scoped WHERE kind = 'agent', so a
// lead's agent_state reads 'unknown' forever by design. Chris, looking
// at a real render: that "unknown" reads as broken. It is not, and this
// pins the fix: no badge at all for a non-'agent' kind, the real last
// agent_state_log event in its place.
```

## line 526

```
// Todo 366's finding, widened by todo 373. An idle latch means "a turn
// ended", and a spawned worker's first turn is hive's own announcement
// while a resumed worker's is the restore replay - neither is work anybody
// asked for. The wake path was the one that could get a worker torn down,
// which is why 366 is low; the page saying a worker finished when it has
// been given nothing is the same misreading with a smaller blast radius.
//
// TWO SITES IN ONE FILE, and that is the whole reason this asserts a
// count. src/dashboard.ts badges a running agent in the NOW strip and
// again in the In Flight list, so a fix applied to the site a reader
// happened to open passes an `includes` and fails this
// (common-issues/a-fix-applied-to-only-some-call-sites.md). The NOW strip
// caps at NOW_AGENTS_SHOWN, so this project seeds exactly one agent.
```

## line 559

```
// The suppression is about one misreading, not about the row being
// untrustworthy: a fresh worker mid-turn really is working, and a badge
// that hedged about that would be inventing a second fact.
```

## line 672

```
// A comment-only project whose comment count alone exceeds
// ACTIVITY_SOURCE_LIMIT. If the cap note reported merged.length (the
// post-truncation count) rather than a real COUNT(*), this would read
// "Showing 30 of 30" instead of naming the 5 comments actually dropped -
// the two-stage version of the silent-cap defect PR #44 nearly shipped.
```

## line 695

```
// Both sources individually stay under ACTIVITY_SOURCE_LIMIT, so nothing
// is lost before the merge; the merge itself is what exceeds
// ACTIVITY_DISPLAY_CAP. This isolates the second cap from the first -
// the source-limit test above cannot exercise this path, since one
// source alone can never fetch past ACTIVITY_SOURCE_LIMIT.
```

## line 791

```
// Superseded by the visual redesign: the earlier round made only the
// board default collapsed, with every other section still defaulting
// open. Chris's follow-up ("it's a lot of info on screen even when pads
// are collapsed") moved the bar - now EVERY <details> section defaults
// collapsed, full stop, and the NOW strip (not a <details> at all, no
// toggle) is the sole thing a fresh session sees expanded. This test
// replaces the old one rather than extending it: the old assertion that
// "todos still defaults open" pinned exactly the behavior this round
// deliberately changed.
```

## line 848

```
// The one-line NOW strip has no room for "last event: ... local" without
// defeating its own 3-second-scan purpose - that detail lives in the In
// Flight section below. Here a lead is silent about status rather than
// fabricating one.
```

## line 871

```
// Before this block, test/dashboard.test.mjs's ONLY escaping assertion
// covered renderBoardSection alone - dropping escapeHtml from a todo
// title, a blocker title, an agent name, a wake body, an activity
// comment's author/body/todo_title, or the project name left the whole
// suite green. Each test below was run against dashboard.ts with that
// sink's escapeHtml call removed and confirmed to fail red before being
// restored, per .claude/sessions/workflows/verify-a-test-goes-red-first.md.
```

## line 917

```
// longer than the 160-char cap, "&" straddles it
```

## line 937

```
// The todo's own title is ALSO escaped once more in the Open Todos
// section above (already pinned by its own test), so counting over the
// WHOLE page would overcount by one. Activity is the last section
// rendered, so slicing from its id to the end isolates it.
```

## line 952

```
// longer than the 200-char cap, "&" straddles it
```

## line 980

```
// The Live toggle (checkbox, see the live-toggle describe block below)
// is the one deliberate exception: read-only means nothing here writes
// back to the STORE, and a display preference kept in sessionStorage
// never does. So the bar narrows from "no <input> at all" to "no
// data-entry <input> - every <input> present must be the toggle
// checkbox and nothing else".
```

## line 993

```
// meta refresh is scheduled by the browser at PARSE TIME; removing the
// tag after the fact does not cancel it, which is exactly why the Live
// toggle could not have been built on top of it. Checked as the exact
// literal tag, not a loose regex: SCRIPT's own comment mentions
// "<meta http-equiv=\"refresh\">" by name (explaining what it replaced),
// and that comment text is itself embedded verbatim inside the page's
// <script> block - a substring match on the tag name alone would false-
// positive on prose, never on a real emitted tag.
```

## line 1025

```
// fresh session, nothing in sessionStorage yet
```

## line 1066

```
// A second, independent script execution reading the SAME sessionStorage
// state - simulating exactly what a reload does.
```

## line 1099

```
// Chris's own framing: a closed section that tells you nothing is just a
// wall of chrome. Each of these seeds real data and checks the count in
// that section's OWN summary line (isolated the same way the pads-section
// tests isolate their section, to avoid matching a number that happens to
// appear elsewhere on the page).
```

## line 1264

```
// Step 2 (todo 309): the scheduler hook that writes renderDashboard()'s
// output to disk. seedProjectAt gives the project a REAL directory on disk -
// unlike seedProject's fake /scratch/... path above, which is fine for a
// pure renderDashboard() call but cannot hold a real hive.yml for the
// enable gate (setDashboardKey, below) or a real .claude/dashboard/.
```

## line 1281

```
// Chris's scope change (superseding plan-dashboard-v1's original directory
// switch): the enable gate is hive.yml's `dashboard` key, not the
// directory's own presence. Writes (or overwrites) hive.yml at the
// project's root with just this one key.
```

## line 1314

```
// The gate (hive.yml's dashboard key) must run BEFORE the claim, not
// after. Claiming first means the claim's UPDATE succeeds once every
// DASHBOARD_MIN_INTERVAL_SECONDS, forever, for every registered
// project - including one that will never render anything - which is
// a permanent periodic write to a WAL store shared by every hive
// session on the machine. See
// .claude/sessions/decisions/2026-08-05-simplify-can-move-a-line-across-a-guard.md:
// the transferable argument is the same shape, moving a line ahead of
// a guard pays nothing when safe and pays only when risky, and here it
// pays most exactly where the work should never happen at all. This
// test is the assertion that fails if a future pass reorders this
// again the way one already did.
```

## line 1350

```
// Live toggle replaced meta refresh (SCRIPT's own timer); the file must
// still declare the Live control that stands in for it.
```

## line 1398

```
// Rewind the claim's own bookkeeping rather than sleeping five real
// seconds: the claim is a plain datetime comparison, so backdating
// last_attempt_at exercises the exact same branch elapsed real time
// would, deterministically and instantly.
```

## line 1412

```
// The specific case a MAX(id)-only mark would miss: agent_state changes
// in place on the same row, so nothing NEW is ever inserted. This is
// exactly the residual the dirty-check redesign (src/db.ts's
// dashboard_meta comment) exists to close.
```

## line 1423

```
// Visual redesign: agent state carries a status word (live/ok/warn),
// not a bare state name in its own tag - "working" reads as "live".
```

## line 1449

```
// A real, forced gap before the second tick: mtimeMs is only convincing
// evidence of "no write happened" if a write in that window would
// provably have produced a DIFFERENT mtime. Without this, a broken dirty
// check that rewrites unconditionally could still land within the same
// instant and pass by coincidence (test/CLAUDE.md's own back-to-back-
// backupNow() lesson, applied here).
```

## line 1466

```
// Todo 329's own trap, named twice in the plan pad: a todo body is stable
// STORE content, not a per-render value like the generated-at stamp, so
// inlining it must not make the hash move on every tick. This is the
// regression this file has shipped before - pin it directly rather than
// trusting the general "nothing changed" case above to cover a new field.
```

## line 1503

```
// The old column-mark watched MAX(id)/MAX(due_at)/MAX(fired_at)/
// MAX(cancelled_at) on timers - a body-only UPDATE (wake_update with no
// delay_seconds) touches none of them, so this edit used to stay
// invisible until an unrelated wake changed.
```

## line 1520

```
// agent_rename's UPDATE (src/spawn.ts) writes agents.name with no
// timestamp at all, so nothing in the old mark ever watched it.
```

## line 1546

```
// A second pad, seeded AFTER the board pad, so its own updated_at is
// later - the exact shape that left the old MAX(updated_at)-based mark
// unchanged after a hard DELETE of the board pad (pad_delete has no
// soft-delete flag; MAX(updated_at) stays monotonic across the DELETE).
```

## line 1569

```
// .gitignore:10 makes .claude/* ignored, so `git clean -xdf` (routine
// after a lane) removes this file with no store change alongside it.
```

## line 1585

```
// The lead's own warning on this follow-up round: the chart and pads
// sections must not sneak a per-render value into the hashed content, or
// the dirty check writes every 5 seconds forever - the exact failure this
// page's own "generated at" stamp is already deliberately excluded from
// hashing to avoid (buildDashboard's comment in src/dashboard.ts). This is
// the same shape as the existing "skips the write when nothing changed"
// test above, run again with real chart data (a completed todo, an open
// todo) and a real extra pad present, so both new sections are actually
// exercised rather than rendering their empty states.
```

## line 1671

```
// Occupy the exact temp-file path the writer will use with a directory
// instead of a file. writeFileSync onto an existing directory throws
// EISDIR unconditionally - portable, and unlike a permission-bit trick,
// not silently bypassed when the suite happens to run as root.
```

## line 1703

```
// Distinct from the EISDIR case above, which pre-occupies the TEMP path
// and so never gets far enough to create a real temp file at all. This
// occupies the TARGET instead: writeFileSync to the temp path succeeds
// for real, then renameSync onto an existing directory fails (POSIX
// rename refuses a file-onto-directory rename), which is the actual
// shape that can strand a temp file if the failure path does not clean
// up after itself.
```

## line 1715

```
// occupy index.html itself as a directory
```
