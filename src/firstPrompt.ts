// THE ONE DEFINITION OF "started, and not yet given anything". Issue #156;
// todo 373 widened it to cover a second start path, and todo 387 narrowed it
// back to the first.
//
// A RESUMED WORKER'S FIRST IDLE IS NOT A FINISH. `claude --resume` replays
// the restored conversation, ends that turn, and fires a Stop hook (issue
// #156) - a real, fresh, correctly-recorded `idle` for a turn nobody asked
// for, and a surface that reports it tells a lead a worker is done before it
// has been given anything - a lead that trusts it tears the worker down.
// Every surface that would answer "this worker is idle, act on it" has to
// ask this first.
//
// A SPAWNED WORKER USED TO HAVE THE IDENTICAL SHAPE THROUGH A DIFFERENT DOOR,
// AND TODO 387 CLOSED THE DOOR RATHER THAN GENERALISE THE LATCH FURTHER.
// agent_spawn used to type a short `[hive]` line into a fresh pane and submit
// it, creating exactly the turn this file exists to un-suppress (todo 373).
// Worse, if a lead's real assignment landed while that turn was still running
// it could be absorbed into it as an attachment with no `UserPromptSubmit` to
// clear the latch (todo 384), and since the ordinary dispatch shape is brief
// once and wait for the finish, that suppression was operationally permanent
// for the worker it hit. Closed by not creating the turn at all: nothing is
// typed into a spawned worker's pane anymore, every fact that line carried is
// already in the brief riding the system prompt, and the one instruction it
// added ("wait for your assignment") moved into the brief text itself
// (src/brief.ts). `SPAWN_ANNOUNCEMENT_PREFIX` and `isSpawnAnnouncement`, which
// used to live here to tell hive's own announcement apart from a real
// assignment, are gone with the turn they existed to discriminate.
//
// ONE FACT, ONE COLUMN. `agents.resumed_at` is stamped by resumeAgent's flip
// and cleared by src/hook.ts on the worker's first prompt - back to meaning
// exactly what its name says, now that launchAgent no longer stamps it too.
// The predicate and its SQL twin below stay general rather than collapsing
// into a resume-specific name, because the column and every reader named
// below still key on "started and not yet spoken to" as a concept, not on
// which start path produced it - a future third start path can reuse this
// machinery the same way todo 373 once did, without every reader changing.
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

// THE READERS, named because enumerating them by hand is how the third was
// missed on issue #156's first pass and how todo 366 became its own todo -
// and this list itself went stale the same way twice more (todo 384/387):
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
//   the "Still going" roster   src/scheduler.ts   the standing watch's OWN
//                              :2925, :2952       finish notice, filtering out
//                                                 an unbriefed worker so its
//                                                 crew claim ("nothing else is
//                                                 running") stays honest - see
//                                                 "A SEVENTH SITE" below, which
//                                                 argues this site at length
//                                                 without ever landing in this
//                                                 list
//   reportUnbriefedWorkers     src/cli.ts         the ONE reader that REPORTS
//                              :2798-2803          on the latch rather than
//                                                 suppressing or describing a
//                                                 row - `hive doctor` naming a
//                                                 worker stuck past a guessed
//                                                 30 minutes (worker-state.md)
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
