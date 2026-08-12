// THE ONE DEFINITION OF "started, and not yet given anything", plus the one
// text that does not count as being given something. Todos 373/366; issue
// #156 built the first half of it.
//
// A WORKER'S FIRST IDLE IS NOT A FINISH, and it reaches that idle two ways.
// `claude --resume` replays the restored conversation, ends that turn, and
// fires a Stop hook (issue #156). A freshly SPAWNED worker does the same
// thing for a different reason: agent_spawn types a short `[hive]` line into
// its pane and submits it, so the worker answers it, that turn ends, and Stop
// fires (todo 373). Both produce a real, fresh, correctly-recorded `idle` for
// a turn nobody asked for, and a surface that reports it tells a lead a
// worker is done before it has been given anything - a lead that trusts it
// tears the worker down. Every surface that would answer "this worker is
// idle, act on it" has to ask this first.
//
// ONE FACT, ONE COLUMN, AND THE COLUMN IS MISNAMED. `agents.resumed_at` was
// added for the resume half and now carries both: launchAgent stamps it in
// its INSERT, resumeAgent stamps it in its flip, and src/hook.ts clears it on
// the first prompt that is not the announcement below. So it means "started
// (spawned or resumed) and not yet spoken to", and its name says only half of
// that. Weighed on todo 373 and accepted rather than renamed: a second column
// spelling the same fact is how this fact's readers drifted apart in the first
// place, and ONE of those readers is a SQL fragment (standingGoneRows,
// src/scheduler.ts) that cannot call a JS predicate - with two columns every
// reader has to remember an OR, and one of them has to remember it inside a
// string. A RENAME migration is append-only-legal and was rejected for a
// sharper reason: an MCP server started before the rename keeps running old
// dist for the life of its session (common-issues/stale-mcp-server-runs-old-
// code.md) and would hit `no such column` inside the scheduler tick and inside
// resumeAgent. See src/db.ts's migration comment, which says the same thing
// where a reader of the schema will find it.
//
// A LEAF MODULE WITH NO IMPORTS, and that is forced rather than tidy. This
// predicate lived in src/stateProvenance.ts, whose header owns exactly this
// argument ("five surfaces each doing their own is how they drift apart"), and
// that module imports src/tmux.ts - while src/dashboard.ts, which is two of
// this fact's readers (todo 366), is deliberately free of any tmux or
// scheduler dependency and says so in its own header. A module with no imports
// at all is the only home every reader can reach. stateProvenance.ts keeps a
// pointer here.
//
// IT ONLY EVER SUPPRESSES. Read that against the withdrawn `also_when_stuck`
// (.claude/sessions/dead-ends/2026-07-29-also-when-stuck-on-latched-waiting.md),
// which this superficially resembles and is the opposite of: that design FIRED
// on a latched state whose end emitted nothing. This one fires nothing, and
// the end of its condition is a `prompt` hook hive already wires and already
// writes on.

// The visible first turn agent_spawn types into a new worker's pane, up to the
// part that is the same for every worker. src/brief.ts builds the real line
// from this constant so the two cannot drift, and src/hook.ts matches on it.
//
// WHY A MARKER AT ALL, since the resume half needed none. A resume types
// NOTHING into the pane, so on that side "the first prompt" really is the
// first moment anyone gave the worker something. A spawn speaks first, and
// what it says is "wait for your assignment" - so treating its own
// announcement as an assignment clears the latch SECONDS BEFORE the idle it
// exists to suppress. Measured on this lane, from agent:208's own rows:
// prompt|working at 03:49:25 (the announcement), stop|idle at 03:49:30 (the
// false finish), prompt|working at 03:49:40 (the lead's real assignment).
// Matching hive's own text in a prompt payload is not new here: deliver()
// prefixes every wake body with `[hive wake #N] ` and checkConfirmations
// (src/scheduler.ts) recognises a delivery the same way.
export const SPAWN_ANNOUNCEMENT_PREFIX = '[hive] You are "';

// A prompt hive typed itself, as part of starting this worker. Anything else -
// a lead's agent_send, a delivered wake, a human typing into the pane - is
// somebody giving this worker something, which is what lifts the suppression.
//
// A PREFIX, NOT AN EQUALITY, because the rest of the line names the worker and
// hook.ts has no cheap way to rebuild it.
//
// THE FAIL-CLOSED DIRECTION, ARGUED AGAINST ITS STRONGEST VERSION (counselors,
// codex seat). A real assignment that happens to start with `[hive] You are "`
// keeps that worker's finish suppressed. The first version of this comment
// called that harmless "because it is silence, not a false report", and that
// is too easy on it: the ordinary assignment is ONE turn, the lead is waiting
// for exactly that finish, and if it sends nothing else there is never a next
// prompt to clear the latch - so the suppression is operationally permanent,
// which is this project's stated worst outcome, not a bounded delay.
// Accepted anyway, on three things the strong version does not overturn: the
// collision needs a lead to open an assignment with hive's own worker-briefing
// sentence verbatim, which nothing in this project's own tooling produces; the
// death half is unaffected (standingGoneRows reads the same column and reports
// a worker that dies latched); and the alternative - matching the whole line,
// rebuilt per worker inside a hook that runs on every turn of every worker -
// buys a narrower match at the cost of a second place the announcement's exact
// text has to be reproduced, which is the drift this constant exists to
// prevent. If it ever bites, the fix is a marker hive controls end to end
// rather than a longer prefix.
export function isSpawnAnnouncement(promptText: unknown): boolean {
  return typeof promptText === "string" && promptText.startsWith(SPAWN_ANNOUNCEMENT_PREFIX);
}

// THE READERS, named because enumerating them by hand is how the third was
// missed on issue #156's first pass and how todo 366 became its own todo:
//   standingIdleRows           src/scheduler.ts   the standing watch
//   watchedStates              src/scheduler.ts   the one-shot
//   wake_when_idle mode="all"  src/tools/wakes.ts the already_satisfied
//                                                 shortcut, which never
//                                                 reaches the scheduler
//   the NOW strip              src/dashboard.ts   a badge
//   the In Flight list         src/dashboard.ts   a SECOND badge, same file
//   standingGoneRows           src/scheduler.ts   the INVERSE reader, in SQL:
//                                                 a suppressed idle was never
//                                                 said, so it cannot be the
//                                                 reason to stay quiet about a
//                                                 death (worker-state.md)
// plus the WRITER that clears it, src/hook.ts, which reads the fact through
// the same SQL helper below rather than spelling it again - the direction that
// fails worst, since a clearer matching nothing suppresses every finish
// forever.
//
// AND EVERY SURFACE THAT DESCRIBES A ROW TO A READER, through
// deriveProvenance/describeForHuman (src/stateProvenance.ts): `hive status`,
// the SessionStart digest (src/kickoff.ts), agent_status and agent_list.
//
// THE EXCLUSION THAT USED TO SIT HERE IS WITHDRAWN, and it is withdrawn rather
// than routed around, because it was argued in writing and was wrong
// (counselors F3). It read: agent_status/agent_list deliberately keep
// reporting the plain latch, since they show what the row says rather than
// deciding anything on it. The line does not survive its own test - the
// dashboard badges only report too, and this lane fixed them (todo 366) on the
// argument that a display saying "finished" about a worker that never started
// is the same misreading with a smaller blast radius. src/kickoff.ts's blast
// radius is LARGER than the dashboard's: nobody chooses to read it, a model
// consumes it at session start and proposes lanes off it.
//
// What survives of the old line, and it is the part worth keeping: these
// surfaces still REPORT rather than decide. `state` remains the raw latch for
// any caller reading JSON, `awaiting_first_prompt` is a fact about the row
// beside it, and only the human-facing sentence is rewritten.
//
// A SEVENTH SITE, AND THIS LANE GOT IT WRONG ONCE - recorded because the
// wrong version was argued in writing here, and the correction is the useful
// part. A standing watch's "Still going" roster (src/scheduler.ts) filtered
// `agent_state != 'idle'`, so a worker awaiting its first assignment appeared
// in neither block of a notice. That was accepted as honest silence. It is not
// silence: an empty roster makes the notice say "Nothing else in this project
// is running right now", which is a CLAIM about the crew, and this lane is
// what made that claim reachable while a live worker sat unbriefed. All three
// counselors seats overturned it independently. The roster reads this
// predicate now.
// A MISSING VALUE IS "NO FACT RECORDED", NOT "AWAITING", and the type check is
// the whole reason this is not a bare `!== ""`. agents.resumed_at is NOT NULL
// DEFAULT '' (src/db.ts), so a row that reaches here without a string did not
// come from the table - it is a partial row literal built by a caller, which
// TypeScript catches in src/ and cannot catch in a .mjs test. Bare `!== ""`
// reads that accident as SET, and this predicate only ever suppresses, so the
// failure would be silence about a worker that really finished. '' already
// means "no fact recorded" for this column; an absent value means the same
// thing, and both read as "not awaiting" here.
export function awaitingFirstPrompt(row: { resumed_at: string }): boolean {
  return typeof row.resumed_at === "string" && row.resumed_at !== "";
}

// The same fact for the callers that are SQL rather than JS: standingGoneRows
// (src/scheduler.ts) and the clearing UPDATE in src/hook.ts.
//
// SAY WHAT THIS ACTUALLY BUYS, because the first version of this comment
// claimed a drift guard it does not provide (/simplify, two seats). The column
// name is still written twice - once in the predicate above, once here - so
// this is not a single source of truth for the spelling. What it does buy is
// that both spellings sit ADJACENT IN ONE FILE, and that `grep
// awaitingFirstPrompt` finds every consumer of this fact including the ones
// inside SQL strings, which a grep for the column name alone would return
// mixed in with every unrelated mention of it.
export function awaitingFirstPromptSql(alias: string): string {
  return `${alias}.resumed_at != ''`;
}
