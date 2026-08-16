# Attic: src/dashboard.ts

Comments removed from `src/dashboard.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 4

```
// A leaf module with no imports of its own, which is why this one is allowed
// where src/stateProvenance.ts is not (that module reaches src/tmux.ts, and
// this file's header explains why it stays free of that).
```

## line 8

```
// Also a leaf module (see its own header) - the canonical slug fallback,
// reused rather than reimplemented. Not imported from
// src/tools/todos.ts, which re-exports the same functions but pulls in
// ../tmux.js at module load, exactly the coupling this file stays free of.
```

## line 14

```
// Pure: reads the store for one project and returns a complete, self-contained
// HTML document as a string. Never touches the filesystem and never decides
// WHEN to run - that is step 2's job (the scheduler hook that writes this to
// disk). Everything below is read-only SQL plus string building.
```

## line 19

```
// Caps for the sections that have no natural bound. Exported so tests assert
// against the real constant rather than a copy of the number that can drift.
// "Cap the unbounded sections AND say on the page that they are capped" - a
// silent top-N reads as "this is everything", which is the defect PR #44
// nearly shipped.
```

## line 27

```
// per source (comments, state log), before merge
// after merge, what actually renders
```

## line 30

```
// Not src/tools/wakes.ts's own truncateBody: that file pulls in agents.ts,
// scheduler.ts and tmux.ts transitively, which is exactly the coupling
// dashboard.ts is deliberately free of (see the module header comment).
// Same shape, different cap per call site (wake bodies vs comment bodies),
// kept local rather than imported.
// The cut itself (never the ellipsis, appended after) goes through
// cutToUnitBudget so it cannot land inside an astral character's surrogate
// pair. No round-trip constraint here (unlike fallbackSlug's zod .max()), so
// the ellipsis is not counted against maxLength - same as before this fix.
```

## line 52

```
// Visual redesign (Chris's request after seeing PR #127): the page now
// draws a hard line between DATA (labels, status, counts, ids, the board -
// the instrument parts, monospace) and PROSE (a todo title, a comment or
// wake body, a pad's own name - human-written text, sans-serif). body's
// default font is the mono stack; this wraps the specific spans that are
// prose. One split, applied consistently, is the whole type system - see
// the STYLE comment below for why that is deliberately the only one.
```

## line 65

```
// hive doctor's own vocabulary (src/cli.ts's report()/warn()/fail() family):
// a status word, lowercase except FAIL, prefixing the thing it describes.
// Chris's instruction is explicit - reuse this rather than inventing badge
// words - so every status concept on the page (a todo blocked or not, an
// agent's state, a wake held or not) maps onto these three, plus "live",
// this page's own addition for something that is currently RUNNING rather
// than passed or failed (a working agent, a pending wake): doctor has no
// occasion to say that, a read-only status page does.
```

## line 80

```
// Formatted by hand rather than through toLocaleString: a fixed, deterministic
// layout that does not depend on the runtime's ICU data or default locale, so
// the same input renders identically on any machine in the same zone. Shared
// by formatLocal (below) and renderDashboard's own "generated at" stamp -
// one formatting implementation for every Date this file ever prints.
```

## line 92

```
// Store timestamps are UTC ('YYYY-MM-DD HH:MM:SS', or with a milliseconds
// suffix for agent_state_log). Rendered in the reading machine's local zone,
// labelled explicitly as "local" so a reader hours away from UTC is never left
// guessing which zone a bare time is in - getting this wrong makes the wakes
// section worse than useless.
```

## line 109

```
// Normalizes a stored timestamp to a sortable key. todo_comments.created_at is
// whole-second ('...SS'); agent_state_log.created_at carries milliseconds
// ('...SS.mmm'). String-compared as-is, a whole-second row and a millisecond
// row sharing the same second sort with the whole-second one first regardless
// of which actually happened later (a shorter string that is a prefix of a
// longer one always sorts first). Padding the whole-second form to the same
// width removes that tie-break bug without changing what is displayed.
```

## line 120

```
// Shared with every other caller in src/ (src/cli.ts, src/tools/agents.ts):
// context.ts already owns project lookups. getProject touches no tmux/spawn
// machinery - only db.js and node builtins - so importing it here does not
// reopen the scheduler/tmux coupling dashboard.ts is deliberately free of.
```

## line 130

```
// ---------------------------------------------------------------------------
// Mirrors ACTIVE_TIMER_WHERE in src/scheduler.ts (one-shot pending, or
// repeating and not cancelled), spelled out locally rather than imported.
// dashboard.ts must not import scheduler.ts: that module pulls in tmux.ts and
// spawn.ts, and step 1's whole point is a generator with no scheduler and no
// tmux dependency at all. If ACTIVE_TIMER_WHERE's definition ever changes,
// this copy has to change with it by hand. Shared by the NOW strip's own
// "next wake" query and renderWakesSection below.
```

## line 140

```
// working is the one state that means "actually running right now" -
// everything else on the page that gets the "live" accent (a pending wake)
// shares that same "in progress, not a verdict" meaning. idle is a plain
// pass (ok); waiting is a worker stalled on a prompt, worth a glance (warn);
// an unrecognised state - a future dist adding one, or the hook's payload
// contract drifting - reads as warn rather than silently as ok, so a real
// problem does not read as fine by default.
```

## line 154

```
// THE BADGE IS A FOURTH AND FIFTH READER of the fact src/firstPrompt.ts owns,
// and it used to read the latch alone: a worker whose only completed turn is a
// resumed worker's restore turn (a spawn-side announcement turn briefly had the
// same shape, later removed) renders a green "idle" - a plain pass for a worker
// that has been given nothing. The wake path was the one that could get a
// worker torn down, which is why this defect is the less severe of the two; the
// display saying "finished" about a worker that never started is the same
// misreading with a smaller blast radius.
//
// ONE HELPER, TWO CALL SITES, and the second site is the reason this is a
// helper at all: an earlier description of "the dashboard" as one reader
// undercounted, since this file has two badges (the NOW strip and In Flight).
// Fixing the one a reader happens to be looking at is this project's most
// repeated defect shape
// (common-issues/a-fix-applied-to-only-some-call-sites.md), reachable here
// without leaving the file.
//
// AN OLD SERVER RENDERS THIS ROW THE OLD WAY, AND IT CAN WIN, recorded here
// because this file is the surface it shows up on. Every hive instance on the
// machine takes the same periodic dashboard claim and writes the same shared
// artifact, so an MCP server started before this branch - running old dist for
// the life of its session, see common-issues/stale-mcp-server-runs-old-code.md
// - re-renders an unbriefed worker as a plain green idle and overwrites the
// corrected page. A newer server rewrites it correctly on its next turn, so the
// page can alternate, and it stays wrong for as long as the old process keeps
// winning the claim. The accepted stale-dist class rather than a new failure -
// the page is a display, it self-corrects on restart, and the wake path (which
// is what could get a worker torn down) is unaffected because the old server's
// own suppression reads the same column. Written down because the shape of the
// stale-dist argument recorded in src/db.ts is about SQL that would fail
// loudly, and this one is silent.
//
// "live" RATHER THAN "ok" OR "warn": the accent already means "in progress,
// not a verdict" (agentStatusLevel above, and a pending wake), which is
// exactly what a worker waiting for its first assignment is. Nothing is
// wrong with it, so "warn" would overstate; it has finished nothing, so "ok"
// is the false report this fixes. ONLY `idle` is rewritten - a row awaiting
// its first prompt that reads `working` really is working, and the badge
// should say so.
// Takes the two fields structurally rather than a named row type: both callers
// pass a different interface (RunningAgentBrief, RunningAgentRow) and both
// already satisfy this.
```

## line 202

```
// Chris, looking at a real render: a lead shows "unknown" and it reads as
// broken. It is not - src/hook.ts's agent_state UPDATE is scoped `WHERE ...
// AND kind = 'agent'` (worker-state.md), so any row that is not kind='agent'
// (today only 'lead', but the scoping is symmetric with the hook's own and
// not a lead-specific carve-out) never gets that latch written at all.
// agent_state reads 'unknown' forever for such a row by DESIGN: the absence
// of a channel, not an unhealthy worker. Rendering a status badge for it
// would invent a fact the store has no answer for, so this predicate exists
// to gate that badge off entirely - see its two call sites below.
```

## line 220

```
// The one real fact the store DOES have for a row with no state channel:
// what it last logged, and when (agent_state_log, never gated on kind -
// every actor's hook writes here regardless). Deliberately NOT
// src/stateProvenance.ts's own lastLogEvent/describeLastLogEvent, which
// hive doctor uses for the same sentence ("last log event: notify (38m
// ago)"): that module imports src/tmux.ts for its event-sanitizing
// formatter, and dashboard.ts must stay free of any tmux dependency (see
// this file's own header comment) - a plain SELECT plus this file's own
// escapeHtml is sufficient for an HTML surface, where stateProvenance's
// pane-typing safety concerns do not apply.
```

## line 236

```
// ---------------------------------------------------------------------------
// The NOW strip. Added on Chris's request after the initial visual review:
// "it's a lot of info on screen even when pads are collapsed" - the fix is
// hierarchy, not less data. This is the ONLY thing expanded by default, has
// no collapse state of its own (it is not a <details> at all), and has to
// answer "is anything running, and what's next" in the time it takes to
// glance at a phone screen. Everything else on the page is drill-down.
```

## line 283

```
// completed7d mirrors the chart's own COMPLETED-ON-DAY-D definition, summed
// over the same CHART_DAYS window (see fetchDayStats below), computed here
// as one direct range query rather than by summing fetchDayStats's own
// per-day rows - this line does not need the day-by-day breakdown, only the
// total, and a >= comparison against six days ago is the same "local day"
// reasoning in one query instead of seven.
```

## line 306

```
// Capped at 5 names: past that, a name list stops being a 3-second scan and
// the Agents section below is where the full list already lives.
```

## line 310

```
// A row with no state channel (hasStateChannel, above - today only a lead)
// gets no badge here at all, name alone: the NOW strip is one line for
// every running row, with no room for "last event: ... local" without
// defeating its own "3-second scan" purpose. That fuller detail is what
// the In Flight section below is for; see renderAgentRow.
```

## line 333

```
// Sparkline scale on purpose: no axis lines, no numbers, no legend - just
// shape. A reader who wants the exact counts and the labelled axis has the
// Throughput section below; this is "is it trending up or down", answered
// in the same half-second as the rest of the strip.
```

## line 354

```
// stats is the SAME fetchDayStats() result renderThroughputSection uses
// below - computed once in buildDashboard and threaded through both, so the
// sparkline and the detailed chart can never show different numbers for the
// same render, and the 7-query cost is paid once, not twice.
```

## line 370

```
// ---------------------------------------------------------------------------
// Section: the board pad, rendered in full.
```

## line 385

```
// ---------------------------------------------------------------------------
// Section: open todos in queue order.
```

## line 403

```
// "Queue order": priority first (a todo you would work sooner sorts first),
// then id, so ties within a priority read oldest-first - the order a human
// would actually pull from the queue. Blocked and dispatchable share this one
// order rather than being split into two lists: the pad's own wording is
// explicit that visual distinctness, not a separate ordering, is what marks a
// blocked todo.
```

## line 417

```
// One batched query for every SHOWN blocked todo, not one query per todo:
// up to TODO_CAP (100) round-trips otherwise, and the caller only ever has
// this many ids to ask about at once anyway.
```

## line 438

```
// 333's fix: the badge used to print "blocked"/"open" - a word the status
// column already owns - so a todo that is in_progress AND blocked read "ok
// open" next to "(in_progress)", contradicting itself. The badge now carries
// the LIFECYCLE status word instead (option 2 from the todo's own body), and
// its color still flags blockedness (warn) so that fact is not lost - it is
// just no longer a second word. "blocked by #N" (below, unconditional on
// blocked) is what actually says a row is blocked; the color is a hint atop
// it, not the only signal.
```

## line 451

```
// 329's fix: title and body were never fetched at all, so there was nothing
// collapsed to expand. Copied from renderPadsSection's <details> (this file
// does not design a new expander shape), with the "blocked by" line kept
// OUTSIDE the <details> - it must stay visible without expanding, exactly as
// it already did before this change.
```

## line 490

```
// ---------------------------------------------------------------------------
// Additional section, added on Chris's request: a 7-day rolling chart of
// throughput against backlog. The detailed, axis-labelled version lives in
// its own collapsed section below; a small sparkline version of the exact
// same data is in the NOW strip above (buildSparkline, fetchDayStats shared
// between both via buildDashboard).
```

## line 500

```
// YYYY-MM-DD, LOCAL calendar day
```

## line 505

```
// Two series, defined exactly this way rather than two "count per day"
// series that would not tell a reader anything they cannot already see from
// the Todos section above:
//   COMPLETED ON DAY D - throughput: todos whose completed_at falls on D.
//   OPEN BACKLOG AT END OF DAY D - todos created on or before D, not yet
//     completed by the end of D (or never completed), and not currently
//     archived. `date(created_at, 'localtime') <= D` is equivalent to
//     "created_at <= end of local day D" (any timestamp ON day D or earlier
//     is <= D's last instant); `date(completed_at, 'localtime') > D` is
//     equivalent to "completed_at > end of local day D" for the identical
//     reason. Both simplifications only hold because D is itself already a
//     LOCAL calendar day, never a UTC one - see the bucketing note below.
//
// BUCKETED BY LOCAL DAY, NOT UTC DAY, and this is the part that is silently
// wrong if you get it wrong rather than loudly wrong: store timestamps are
// UTC, so on a UTC-4 box, work done after 20:00 local already carries
// tomorrow's UTC date. Every date() call below carries the 'localtime'
// modifier for exactly this reason, and every day boundary is computed via
// SQLite's OWN `date('now', 'localtime', ...)`, not via JS Date math - one
// clock decides both "which day is this" and "does this row fall in it", so
// there is no way for Node's and SQLite's notions of local time to disagree
// with each other even if they were ever configured differently. Measured
// directly (not assumed): mutating process.env.TZ mid-process changes what
// better-sqlite3's own 'localtime' modifier reports on the very next query,
// confirming this doesn't need to be read only at process start.
```

## line 541

```
// One query per day (not one query with a generated date series): CHART_DAYS
// is a small constant (7), so this is seven cheap indexed lookups, and each
// day's "day" label and both its counts come from ONE statement - so a
// single moment's `'now'` decides all three, never two statements whose
// `'now'` could in principle straddle a boundary between them.
// Exported so tests can assert on the actual computed local-day buckets
// directly, rather than reverse-engineering SVG coordinates or regexing the
// generated markup for its own sake (test/CLAUDE.md's own bar) - this is the
// seam that actually varies with the timezone-sensitive behaviour under
// test, per .claude/sessions/dead-ends/2026-08-05-helper-whose-parameters-
// cannot-disagree.md's own lesson: make the thing that DIFFERS the unit.
```

## line 567

```
// matches --ok
// matches --live
```

## line 570

```
// Hand-drawn, inline SVG - no chart library, no CDN (the page is one
// self-contained file that has to work from file:// with no network). Axes are
// sized to whatever the real data is (no hardcoded scale): the y-axis max is
// the largest value EITHER series actually reaches this render, with a little
// headroom so the top point's own dot never clips against the plot's edge.
// Every one of the CHART_DAYS days is always plotted, including a day whose
// count is genuinely zero - the data is never filtered down to "days with
// activity", so a zero renders as a point sitting on the baseline, not as a gap
// in the line.
```

## line 582

```
// headroom so a max-value point's dot never clips the top edge
```

## line 599

```
// MM-DD, today marked partial
```

## line 632

```
// ---------------------------------------------------------------------------
// Section: in flight - running agents and their live state.
```

## line 646

```
// hasStateChannel's own comment has the full reasoning. For a row with none
// (today only a lead), the badge and its "since" line are replaced with the
// last thing this actor actually logged, which is real and does exist
// (agent_state_log carries no kind gate at all - every actor's hook writes
// there) - never a fabricated "unknown" status.
```

## line 682

```
// ---------------------------------------------------------------------------
// Section: pending wakes, with local fire times.
```

## line 714

```
// A held wake (stuck behind a dialog, or unsubmitted input in its
// target pane - src/scheduler.ts's deliverable()) is worth a glance in
// a way an ordinary pending one is not, so it reads warn rather than
// live: "this one needs a human", not "this one is on schedule".
```

## line 730

```
// ---------------------------------------------------------------------------
// Section: recent activity - todo comments and agent_state_log transitions,
// merged into one reverse-chronological list.
```

## line 762

```
// COUNT(*) OVER () rather than a second COUNT(*) query: it is evaluated
// over every row matching the WHERE/JOIN before ORDER BY/LIMIT truncates
// the OUTPUT, so it carries the TRUE total on every returned row - one
// scan instead of two. Verified directly (not assumed): 35 comments
// seeded, LIMIT 30, every one of the 30 returned rows read total_count
// 35, not 30.
```

## line 791

```
// Joins each log row to the one agents row that owns its actor_id today,
// preferring a running row over a closed one and the highest id among ties -
// the same join shape as DELIVER_SOCKET_JOIN in src/scheduler.ts, copied
// rather than imported for the same reason PENDING_WAKE_WHERE is copied
// above. agent_state_log carries no project_id of its own by design (see the
// migration's comment in src/db.ts): a hook must never fail, and a foreign
// key to a row that can be closed and swept would risk exactly that.
```

## line 799

```
// Same COUNT(*) OVER () consolidation as fetchCommentActivity above, and
// more load-bearing here: agent_state_log is append-only and can hold up
// to LOG_MAX_ROWS (20,000, src/scheduler.ts) rows, and the correlated
// actor_id -> agents join has no index to drive a LIMIT-style early exit.
// A separate COUNT(*) query paid for that full join twice on every
// regenerate; one query pays for it once.
```

## line 828

```
// The cap note's "total" is the TRUE count from both sources (COUNT(*),
// unbounded), never merged.length. merged.length is bounded twice over - once
// by each source's own ACTIVITY_SOURCE_LIMIT, once by the slice below - and
// reporting it as "total" would silently hide whatever a source's own LIMIT
// already dropped before the merge ever saw it: the two-stage version of the
// exact silent-cap defect this whole file's cap notes exist to prevent.
```

## line 853

```
// ---------------------------------------------------------------------------
// Additional section, added on Chris's request: every active pad, listed and
// individually expandable. Placed after Activity - reference material for
// browsing, not part of the "what's going on, what's next" narrative the
// earlier sections answer.
```

## line 865

```
// Pad names are unique per project (idx_scratchpads_active_name), but two
// DIFFERENT names could in principle slug to the same id after stripping -
// accepted rather than guarded against: the only consequence is that two
// such pads would share one sessionStorage expand/collapse entry, a cosmetic
// residual on a read-only page, not a correctness one.
```

## line 881

```
// ACTIVE PADS ONLY (archived = 0): an archived pad is not live state, and
// inlining it too would roughly triple this section's size for data nobody
// reading "what's going on right now" needs - measured on the real store
// this lane targets, 9 active pads besides the board run ~388KB; adding
// archived ones was measured at 1.25MB. `board` is excluded outright: it
// already has its own section above, in full, and inlining its ~53KB a
// second time here would be silly - the intro line below says so in one
// line rather than leaving the omission to speak for itself.
```

## line 916

```
// ---------------------------------------------------------------------------
// Shared page chrome.
```

## line 919

```
// pluralNoun is the whole plural phrase ("open todos", "recent activity
// entries"), not a singular auto-pluralized with a bare "s" - "entry" + "s"
// reads as "entrys", and that bug is exactly the shape a fixture too small to
// reach the cap would hide (test/CLAUDE.md's shape 6).
```

## line 928

```
// The shape every list section shares: a cap note (empty when nothing was
// dropped) followed by either the rendered list or an empty-state message.
// Only the CSS class, plural noun, rows markup, and empty message differ
// per section.
```

## line 946

```
// <details> gives collapse/expand for free with no JS required for the
// mechanism itself; the inline script below only persists which elements are
// open across the 10s meta-refresh, which <details> does not do on its own.
//
// countText is the thing a CLOSED section still says out loud ("todos — 4
// open, 1 blocked"): Chris's own framing is that a collapsed section telling
// you nothing is just a wall of chrome, so every summary carries one. Always
// plain text (escaped here, like title), never HTML the caller half-built -
// every count on this page is numbers and fixed words, never user data, so
// there is nothing a caller would ever need to pass pre-escaped.
//
// The summary is styled as a tmux pane-border-status line (`.pane-border` in
// STYLE below) rather than a boxed card header - hive's own vernacular
// instead of invented dashboard chrome, per Chris's instruction.
//
// defaultOpen is what the HTML says BEFORE sessionStorage has a chance to
// run - the state a reader with no stored preference (or a fresh tab) sees.
// EVERY section defaults CLOSED now (the visual redesign's own point: the
// NOW strip above is the only thing expanded by default, full stop) - and
// because that default lives in the markup itself, not in SCRIPT, a reader
// whose JavaScript fails to run still sees a closed, uncluttered page rather
// than one silently defaulting back open. SCRIPT's restore step always runs
// after this markup lands, so a reader who has actually toggled a section
// keeps getting THEIR choice back, every refresh; this default only governs
// the very first render of a session with no stored preference at all.
```

## line 980

```
// Colors map onto hive's own ok/warn/fail/live vocabulary rather than an
// invented palette (Chris's instruction) - four hues total, plus neutrals.
// Full light palette on :root, dark values overridden only where they
// differ (prefers-color-scheme, no toggle - this is a generated static
// file, not an Artifact with a runtime theme switch). body gets an explicit
// background so it can never inherit the viewer's own page color. Avoided
// on purpose: acid green on near-black (the default "hacker terminal"
// look) and cream-with-terracotta (the default "warm SaaS" look) - neither
// says anything about this tool. Dark mode is graphite, not black; every
// status hue is muted rather than neon.
```

## line 1102

```
// Persists scroll position, every <details>'s open/closed state, and the Live
// toggle in sessionStorage, restored on load. Required because a reload (meta
// refresh originally, now this file's own timer below) is a full navigation:
// without this the page scroll-jumps to the top and re-expands every section on
// every cycle, which is unusable at this data volume.
//
// Selects every "details[id]", not just "details.section": the pads section
// (renderPadsSection) nests one <details id="pad-..."> per pad, and a reader
// who expands one wants it to stay expanded across the reload exactly the
// way a top-level section does - one mechanism, not two, and a future
// nested <details> with an id is covered automatically with no second edit
// here.
//
// RESTORE RUNS FIRST, as the very first statements in this IIFE, with
// nothing gating it behind DOMContentLoaded or load: every cycle is now a
// full navigation, so scroll position and section state have to be fixed up
// before the reader can perceive the reset the reload just did, not after
// the whole document (and whatever future feature gets added below this
// comment) has settled. Keep new code AFTER this block, never before it.
```

## line 1189

```
// The dashboard_meta.last_mark column used to hold a hand-picked set of MAX()
// columns (see dashboard_meta's own migration comment in src/db.ts for that
// design's history) that was a SHADOW of exactly what the render functions
// above actually read - and the shadow was already wrong four ways:
// wake_update(body) changes rendered text (renderWakesSection) but touches none
// of the timer columns the old mark watched; agent_rename writes agents.name
// with no timestamp at all; pad_delete is a hard DELETE, so MAX(updated_at)
// stays monotonic and can go on describing a pad that no longer exists; and two
// writes inside one whole-second timestamp can make the second one invisible.
// None of those were "stale for one interval" - they were stale until some
// UNRELATED watched value happened to change, which on a quiet project could be
// never. And the shadow was not even cheap: its state_log_mark clause ran the
// identical expensive correlated join fetchStateLogActivity does, once per
// agent_state_log row, defeating its own purpose.
//
// Replaced with a hash of the RENDERED CONTENT itself - correct by
// construction, since there is no second query to drift out of sync with
// what actually gets rendered. renderDashboardForWrite is the one function
// that does this: it renders every section and the project name exactly
// once, returns both the finished HTML (for the caller to maybe write) and
// a hash of that same render (for the caller to compare against
// dashboard_meta.last_mark) - so scheduler.ts's dirty check no longer costs
// a second render the way the old mark query effectively did.
//
// THE STAMP-EXCLUSION TRAP, decided deliberately rather than discovered by
// a failing test: renderDashboard's own output embeds a "generated at"
// timestamp (see the `generatedLocal` line below), which changes on every
// single call. Hashing the FULL html including that stamp would make the
// hash differ every render, permanently defeat the dirty check, and write
// the file every scheduler tick forever - the identical self-defeating
// bookkeeping shape that killed this table's own total_changes() design
// (src/db.ts's dashboard_meta comment: "the dirty check was defeated by its
// own bookkeeping, forever"). So the hash is computed over the project name
// and the rendered SECTIONS only, joined with a NUL separator (content
// this page's own escapeHtml never produces, so two different underlying
// renders cannot collide onto the same joined string by accident) - never
// over the timestamp. The timestamp is appended to the html AFTER hashing,
// in the same render pass, so what gets hashed and what gets displayed stay
// derived from one single set of section renders.
//
// The NOW strip, the throughput chart (in both its sparkline and detailed
// forms) and the pads list are all built from STORE data and from LOCAL
// CALENDAR DAY boundaries that only change once every 24h - none of them
// reads wall-clock "now" into its own displayed content the way the page's
// "generated at" stamp does, so none of them defeats this hash the way a
// naive full-html hash would.
```

## line 1253

```
// No <meta http-equiv="refresh"> here any more - SCRIPT's own timer
// replaces it, precisely so the Live toggle can turn it off (see SCRIPT's
// own comment for why a meta tag could not support that). The checkbox
// defaults `checked` in the markup itself, matching every other on/off
// default on this page (section()'s own defaultOpen): a reader whose
// JavaScript never runs still sees a page that LOOKS live, even though
// without JS nothing here ever reloads or toggles - the honest limit of a
// "no libraries, self-contained" page.
```

## line 1283

```
// Render the project's store as one self-contained HTML document. Read-only:
// no forms, no writes, no editing anywhere on the page.
```

## line 1289

```
// src/scheduler.ts's write hook. One render produces both values it needs:
// the html to (maybe) write, and a hash of that render's content - excluding
// the "generated at" stamp, see buildDashboard's own comment above for why -
// to compare against dashboard_meta.last_mark.
```
