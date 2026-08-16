# Attic: src/stateProvenance.ts

Comments removed from `src/stateProvenance.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 1

```
// Every state hive reports is a LATCH read at a distance: agents.agent_state
// is one row, overwritten in place by hooks Claude Code fires on its own
// schedule (src/hook.ts). This module is the one place that turns that latch,
// plus what else the store knows about the same actor, into something a
// reader can judge for themselves instead of trusting blindly. It reports;
// it never judges. There is no bound, threshold, or "stuck" verdict here and
// there must never be one added -- that is lane L2, and it was redesigned
// away from a bound after a query against the live
// store. Every surface that shows a worker's state calls deriveProvenance()
// so the clock arithmetic and the source labelling exist in exactly one
// place; five surfaces each doing their own is how they drift apart.
//
// THE LATCH IS AUTHORITATIVE, THE LOG IS FORENSICS, IN THAT ORDER, ON
// PURPOSE. agents.agent_state + state_changed_at is written first and never
// lost. agent_state_log is written second, in its own try/catch
// (src/hook.ts's record()), specifically so a log that cannot be written
// costs the diagnosis and never the worker's actual state. It is also pruned
// by a GLOBAL id span across every actor and project (pruneStateLog,
// src/scheduler.ts), so a quiet worker's own rows can be evicted by a
// completely different actor's churn while its latch survives untouched.
// Consequence for deriveProvenance()/StateProvenance specifically (narrowed
// from a module-wide claim, which lastLogEvent below now makes false as
// written): AGE NEVER DEPENDS ON THE LOG THERE.
// age_seconds and since come only from state_changed_at. Only the EVENT that
// explains the current state can be missing, and when it is, that is
// reported as its own named answer (source "no-record") rather than as an
// age of zero or a guess.
//
// lastLogEvent (below) is the DELIBERATE exception, for a different question
// entirely: not "how old is the latch" but "how old is the log's own last
// row". Its age_seconds comes from agent_state_log.created_at on purpose --
// that is the whole point of the function, see its own comment. The
// retention argument above does not sink this: a row that has been evicted
// is reported as null (absence), never as a fabricated age of zero, and
// deriveProvenance's own latch age on the line above is completely
// unaffected by whether that log row still exists.
//
// THE FRESH-PROVENANCE TRAP. Under a /goal, Claude Code fires Stop after
// every turn while immediately starting another, so a worker can sit through
// nine consecutive false idles in fifty seconds (worker-state.md). Every one
// of those rows is real and every one is honest about the row and worthless
// about the worker: "idle, from a stop row, 2s ago" reads as MORE
// trustworthy than a bare "idle" did, precisely because it is fresh. This
// module cannot detect that condition -- a fresh, correctly-recorded stop row
// is indistinguishable here from a fresh, correctly-recorded stop row that
// happens to sit under a /goal -- and must not pretend to. Say so at the
// point a reader will see it: this comment is that point.
//
// WHAT L2 WILL NEED THAT THIS MODULE DOES NOT GIVE IT. L2's firing condition
// is "a worker sits in `working` with no STOP ROW SINCE THE LAST PROMPT, and
// then an idle_prompt notify arrives" -- a predicate over the ORDERED
// SEQUENCE of an actor's recent agent_state_log rows, not over a single
// latest-matching-row lookup. deriveProvenance()'s `event` field answers
// "which row explains the CURRENT state" and is the wrong tool for that: it
// deliberately stops looking once it finds a row whose state matches the
// latch, which is not the same query as "has a stop row appeared since the
// last prompt". L2 should query agent_state_log directly for the sequence it
// needs rather than build on this field.
```

## line 65

```
// Lazily cached rather than prepared at module scope: this module loads
// before migrate() runs (same reasoning as src/scheduler.ts's own stmt()),
// so preparing against tables that may not exist yet would throw on a fresh
// database. deriveProvenance can run once per row in an agent_list loop, so
// re-preparing identical SQL on every call -- rather than compiling it once
// and reusing the plan -- is real, avoidable cost there.
```

## line 90

```
// "This worker has not been given anything yet"
// (src/firstPrompt.ts), carried here because three of this function's four
// callers need it and one of them is read by a MODEL rather than a person:
// src/kickoff.ts injects its WORKERS block into a fresh lead's context
// alongside the instruction to triage what it just read, so an unqualified
// "idle for 3m" about a worker nobody has briefed is a fact that surface
// manufactures. `hive status` is the same sentence for a human, and it is
// the triage surface the runbook sends a lead to.
//
// OMITTED WHEN FALSE, never rendered as `false`: these fields land in every
// agent_list and agent_status receipt, and a lead makes hundreds of those
// calls in a wave (.claude/rules/tool-contract.md, slim receipts). Absence
// is the ordinary case and says the same thing.
```

## line 106

```
// The fields deriveProvenance needs off an agents row. AgentRow (src/tools/
// agents.ts) is a superset and satisfies this structurally; kickoff's
// narrower SELECT is written to include exactly these.
```

## line 115

```
// src/cli.ts and src/tools/agents.ts reach this through SELECT *;
// src/kickoff.ts names its columns and had to gain this one.
```

## line 120

```
// SQLite's datetime('now') and this schema's other timestamp columns are
// UTC with no timezone marker ("2026-07-31 03:58:07"). Parsed as-is that
// reads as local time and comes out hours off; the "T"+"Z" round-trip is
// what makes it parse as the UTC instant it actually is. Also handles
// agent_state_log's millisecond variant ("...07.123") unchanged, should a
// future caller ever need it here.
```

## line 134

```
// One humanising function, boundary-tested, so every surface renders the
// same age the same way.
```

## line 142

```
// alive is the caller's own tmux liveness read (isLive/summaryLiveness in
// src/tools/agents.ts), passed in rather than probed here: this module stays
// a pure reader of rows it is given, and a surface that has already decided
// not to shell out to tmux (kickoff, deliberately -- see kickoff.ts) can
// pass null and get an honest "not probed" rather than a wrong "gone".
//
// now is exposed for tests: age must be computed from a fixed instant, never
// from a real clock a test has no control over.
```

## line 160

```
// The tmux probe is a second, independent source of truth about the same
// field agentSummary already overwrites with "gone" (src/tools/agents.ts).
// When it is what answered, it must be named as the source: stamping "hook"
// on an observation a hook never made attributes it to the wrong witness.
```

## line 168

```
// A non-claude worker never receives --settings (src/tools/agents.ts,
// gated on isClaudeCommand) and so writes NO hook row, ever, by design.
// That must read as a permanent, uninteresting fact, never as staleness.
//
// A lead is the same shape for a different reason: it DOES get --settings
// and its hook DOES fire, but src/hook.ts's agent_state UPDATE is scoped to
// kind = 'agent' (worker-state.md), so agent_state never leaves its
// 'unknown' default. isClaudeCommand(row.command) alone cannot tell that
// apart from a genuinely fresh, about-to-report worker - which is exactly
// "no-record"'s meaning, and reporting a lead that way (issue #27) reads
// as a worker that just hasn't checked in yet
// rather than one with no state channel at all, permanently, by design.
//
// This used to be `!isClaudeCommand(row.command) ||
// row.kind === LEAD_KIND` -- a blocklist naming leads specifically, and
// wrong for a kind='command' row (a hive.yml process started by `hive
// start`, src/cli.ts): launchAgent gives a non-'agent' kind no
// HIVE_AGENT_ID and no --settings (src/spawn.ts), so a kind='command' row
// running `claude -p '...'` can never write a hook row or a log row
// either, exactly like a lead. The old gate let it fall through to the
// instrumented branch below and report "no-record" forever -- "a claude
// worker that hasn't checked in yet" -- which is precisely the misreport
// the lead fix above addressed, just for a different kind. Now shares
// reportsAgentStateLog (below) with agent_list/hive status/hive doctor, an
// ALLOWLIST on kind='agent' rather than a lead-specific exclusion, so the
// two cannot independently drift onto different readings of the same row
// again, and a future third kind defaults to not-instrumented rather than
// to no-record by accident.
```

## line 210

```
// The log row that actually explains the current latch value: the most
// recent row for this actor whose OWN state matches agent_state now. Not
// simply "the last row for the actor" -- a notify that left the latch
// alone is logged with the literal state "unchanged" (src/hook.ts's
// UNCHANGED sentinel), which is not a value agent_state can ever hold, and
// the true explaining row can be an OLDER one that retention has not yet
// reached. Skipped entirely when the latch itself has never changed, since
// no log row could possibly match a state that was never written.
```

## line 231

```
// REPORTED FOR EVERY STATE, RENDERED ONLY FOR `idle`. The fact is true of
// a worker mid-announcement-turn too, and a caller reading JSON should get
// it; describeForHuman below rewrites only the sentence that is actually
// wrong, matching the dashboard badge and the standing watch's roster so
// all three read one row the same way.
```

## line 240

```
// Human-facing, one line, for surfaces that render for a terminal (hive
// status, kickoff, doctor). MCP surfaces report the StateProvenance fields
// directly instead of this string: a caller parsing JSON should not have to
// re-derive a sentence hive already threw away.
```

## line 245

```
// `idle` about a worker nobody has briefed is the
// same misreading the wake path suppresses and the dashboard badge relabels,
// and this string is where it reaches a lead: `hive status`, and the
// SessionStart digest a fresh lead is told to triage. The event is dropped
// rather than kept - it is always the announcement's own `stop`, and naming
// it invites the reader to weigh a fact that means nothing here - while the
// age stays, because "how long has it been sitting unbriefed" is exactly the
// question this sentence should provoke.
```

## line 274

```
// Issue #72. A SEPARATE reader from deriveProvenance above, on purpose: this
// module's own docstring already names why. deriveProvenance's `event`
// answers "which row explains the CURRENT latch value" and stops looking the
// instant it finds one, which is a different question from "what did this
// actor's log most recently record, full stop". A worker stuck on a dialog
// for 40 minutes has a latch that has not moved and a matching log row that
// has not moved either, so deriveProvenance reports it correctly as
// `waiting (notify, 40m ago)` -- and #72's whole premise is that a
// correct-looking provenance line is exactly what a lead keeps missing here,
// because nothing about it says the age is worth a second look. This
// function reports the same underlying row a different way: not "what
// explains the latch" but "the single most recent thing this actor's log
// holds", so a caller can show it on its own line instead of overloading a
// field named for a different purpose.
//
// Reports, never infers. There is no "stale" or "stuck" verdict here, same
// rule as deriveProvenance and for the same reason -- a caller judges the
// age for themselves.
```

## line 299

```
// null means no row for this actor. Callers report that as its own named
// fact (mirroring deriveProvenance's "no-record"), never as an age of zero:
// retention (pruneStateLog, src/scheduler.ts) deletes agent_state_log by a
// GLOBAL id span across every actor's rows together, not per actor, so a
// quiet actor's last-ever row can be evicted by a completely unrelated
// actor's churn. null can mean "this actor has never reported" or "it did,
// and retention already took it" -- indistinguishable from inside this
// table alone, which is why it is reported as absence rather than guessed at.
```

## line 315

```
// One human-facing formatter for lastLogEvent, same reason describeForHuman
// exists above: `hive status`, `hive doctor` and the wake body scheduler.ts
// types into the lead's pane all render this line, and a second surface
// hand-rolling the string is how they drift apart.
//
// log.event is process.argv[2] verbatim (src/hook.ts), attacker-influenced
// with no validation, and every one of those three callers embeds this
// function's return value somewhere hive did not fully control - two of them
// an operator's own terminal, one a pane hive types into as a user turn.
// sanitizeEventForDisplay (src/tmux.ts) caps and cleans the EVENT before it
// is formatted, not the finished sentence, so hive's own "(<age> ago)" can
// never be pushed out of view or duplicated; see that function's own comment
// for the full reasoning. Sanitizing here, in the one formatter all three
// callers share, is what makes "fix both CLI sites too" a one-line change
// rather than three copies of the same guard.
```

## line 334

```
// The one fact "does this row have a state log worth reporting" reduces to,
// shared so agent_list, hive status and hive doctor cannot drift onto three
// slightly different tests of it. An allowlist on kind (not a lead-specific
// exclusion) on purpose, matching src/hook.ts's own UPDATE scope
// (worker-state.md): a future third kind defaults to no report, not to
// reporting by accident. A lead DOES write agent_state_log rows of its own
// (worker-state.md's goal-churn section), which is deliberately not what
// this predicate is about -- #72's surface is for a worker's liveness, not a
// lead's, and a lead's own churn is out of scope for it.
```

## line 347

```
// Issue #156 lived here as awaitingFirstPostResumePrompt. It later MOVED
// to src/firstPrompt.ts, unchanged in what it means and widened in what it
// covers: a spawned worker's announcement turn produces the same false finish
// a resumed worker's restore turn does, so the fact is now "started, and not
// yet given anything" rather than "resumed, and not yet spoken to".
//
// THE MOVE IS FORCED, NOT TIDYING, and the reason belongs here because this is
// the module whose header claims to be the one place such a fact may live.
// src/dashboard.ts is two of that fact's readers and is
// deliberately free of any tmux or scheduler dependency - it hand-rolls its
// own lastLogEvent rather than importing this module's - while THIS module
// imports src/tmux.ts for sanitizeEventForDisplay. A leaf module with no
// imports is the only home every reader can reach. The stance is unchanged:
// one definition, every reader calls it, and its own file names them all.
```
