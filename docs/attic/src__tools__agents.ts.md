# Attic: src/tools/agents.ts

Comments removed from `src/tools/agents.ts` by todo 436, verbatim. Line numbers are
positions in the pre-strip file at fed8064.

## line 87

```
// One ordering rule, one string, shared by closedAgentNamed here and
// findClosedAgent below - both scan a project's non-running rows for a name
// match, and until todo 364 their ORDER BY clauses were independent, hand-
// copied literals that happened to agree. Todo 364 added parked-first
// priority to findClosedAgent alone; leaving closedAgentNamed's copy
// unchanged would have silently broken the "kept consistent anyway" promise
// closedAgentNamed's own comment below already makes. PARKED FIRST
// ((parked_at != '') reads as 1/0 in SQLite, DESC puts 1 first), then
// most-recently-closed within each group - closed_at, not id, because
// agent_resume can reopen and reclose a row out of id order.
```

## line 99

```
// The most recently closed agent whose name matches, folded the same way the
// running passes fold. Only reached when no running agent answered, so the
// scan over a project's dead agents stays off the hot path.
//
// This function only feeds an error message naming which closed agent to
// spawn a replacement for, so getting it wrong is cosmetic here, not a
// resume gone to the wrong session - CLOSED_ROW_ORDER is shared anyway so
// the same query does not read two different ways in one file.
```

## line 120

```
// Shared by findAgent and findClosedAgent's own agent_id branch below - one
// row-by-id lookup and one not-found sentence, parameterized on the hint
// each caller wants ("Call agent_list." vs "...(include_closed: true)."),
// rather than the identical SELECT and not-found shape written out twice.
```

## line 132

```
// Todo 369. agent_close and agent_park both kill a pane and then take a
// conditional write (closeAgentRow / parkAgentRow) on id + status='running' +
// tmux_target - the same CAS shape, same failure mode. When the CAS loses,
// the row itself already says what actually happened; re-reading it turns a
// guess ("nothing was closed/parked", blaming a fixed cause) into a fact.
// Exactly two things can be true of a row a lost CAS did not write:
// something else already retired it (closed, or closed+parked - the caller's
// real question, and the ONLY case where "nothing changed" is honest), or it
// is running again on a fresh pane (a genuine loss - the only case that
// deserves a refusal). No third status exists (schema CHECK, src/db.ts).
//
// Pure and exported so this is testable by construction: the real race
// this reports on cannot be triggered through the live MCP surface any more
// than closeAgentRow's own CAS can (see test/close-agent-row-target-guard.
// test.mjs's own comment on why), so the outcome this computes is pinned
// directly against a synthetic row rather than a live tmux race.
```

## line 154

```
// The "revived" half of a lost-CAS report, shared by agent_close and
// agent_park (/simplify, todo 364): both name the plausible cause and the
// verb-specific remedy, so only those two fragments vary by caller.
//
// "is running again", not "...on a different pane" (counselors, opus, same
// fix round as classifyLostCas's own retired-branch fix above): this
// classification only knows status='running' again, not that a pane is
// already attached to it. resumeAgent's own flip (src/spawn.ts) commits
// status='running' with tmux_target='' for the span of the resume, so a
// re-read landing in that gap would have asserted a pane that does not yet
// exist. Dropping the clause makes the sentence true in both cases instead
// of only the common one.
```

## line 184

```
// Strict precedence, strongest signal first, so a shorter name can never
// be shadowed by a longer one that happens to contain it: "impl" resolves
// to impl even while impl-followup is running.
```

## line 197

```
// A name the caller typed in full must never resolve to a DIFFERENT
// worker. Closing "impl" while "impl-followup" runs would otherwise make
// agent_close(name="impl") kill the wrong pane, because the running-only
// filter above turns the exact match into a miss and the substring pass
// happily takes the sibling. Report the closed worker instead. Checked
// after the running passes so that reusing a closed worker's name still
// resolves to the live one.
```

## line 206

```
// Issue #27's L4 fix round R10, todo 182 item 3 (opus). "Spawn a new
// worker" is impossible advice for a retired LEAD - newly reachable
// since todo 176 let agent_close retire a confirmed-dead lead row at
// all: "lead" stays reserved (isReservedAgentName), so agent_spawn
// refuses it outright, and the actual remedy is `hive lead` from a
// terminal.
// A PARKED LANE IS NOT A CLOSED ONE, AND THIS IS THE MESSAGE A
// NEXT-MORNING LEAD HITS FIRST (counselors, opus + fable). `agent_send(
// name: "impl")` or `agent_status(name: "impl")` at 09:00 used to answer
// "is closed. Spawn a new worker" for the lane the lead deliberately
// parked at 18:00 - verbatim the confusion issue #156 was filed about,
// produced by the feature meant to end it. The branch already had the
// shape for a third remedy; it only lacked the fact.
```

## line 245

```
// agent_resume's own resolver: findAgent above only ever returns a RUNNING
// row (the "closed" case is a helpful error, not a result), and that is the
// wrong default for a tool whose whole job is to act on a closed one.
// Exact, case-insensitive match only, no partial fallback - unlike
// findAgent, closed rows are not a namespace anything else has to
// disambiguate against, so a caller who does not remember the exact name
// gets pointed at agent_list rather than a guess.
//
// Todo 364, CLOSED_ROW_ORDER's own mechanics comment above. closed_at, NOT
// id, is what breaks a tie within a priority group (counselors, codex): a
// resumed row keeps its id but gets a FRESH closed_at if it is closed
// again, so id order and close order can disagree the moment agent_resume
// exists - id 10 resumed and reclosed after id 11 first closed is more
// recently closed despite the lower id. A name is only unique among RUNNING
// rows (idx_agents_running_name), so "impl" spawned, closed, and spawned
// again leaves two closed rows sharing it - and PARKING one of them does
// not free the name (a parked row is still status='closed'), so "impl"
// parked at 18:00 then spawned and ORDINARILY closed at 09:00 used to have
// closed_at alone pick the 09:00 row: `agent_resume(name: "impl")` silently
// resumed the wrong lane, with no error to notice by. Lead triage on todo
// 364: a parked lane is a promise this project already makes legible
// (agent_park's whole point), and closed_at ordering it alongside an
// ordinary close breaks that promise the moment the two ever collide on a
// name.
```

## line 292

```
// The core liveness rule of the agent model: a row is live only while it is
// open in the store AND its tmux target still exists. Returns null when tmux
// could not be asked, which every caller must handle as its own case: reading
// unknown as dead is what closed live workers (issue #14).
// End an agent's pane and leave the survivors arranged the way hive placed
// them. Shared by agent_close and agent_park (issue #156): the two differ in
// what they write to the ROW, and not at all in how they take the pane down,
// so a second copy of this would be two places for the re-tile reasoning below
// to drift apart. Called only where the caller has already probed the target
// as live - unknown liveness must never be treated as dead (issue #14), and
// that decision stays with the caller because agent_close's own lead-retirement
// path turns on it.
// TODO 371 CHANGED WHICH BRANCH A WINDOW-PLACED WORKER TAKES, AND THAT IS A
// BEHAVIOUR CHANGE, NOT A CONSEQUENCE OF STORING A DIFFERENT ID. Every row now
// records a pane id (placeAgentPane, src/spawn.ts), so a placement="window"
// worker reaches kill-pane where it used to reach kill-window. For the
// ordinary case - that worker alone in its own window - the outcome is
// identical, since tmux reaps a window whose last pane dies. It differs in
// exactly one case, and there the new behaviour is the point rather than the
// price: a window-placed worker's window can hold a second pane, because
// splitTargetWindow places a split-placed CHILD into its parent's window
// (test/split-window-parent-placement.test.mjs pins that), and kill-window
// took that child's pane down too. Closing one worker silently killed
// another. It no longer does.
//
// THE WINDOW BRANCH STAYS, AND IT IS NOT DEAD CODE. A row can still hold a
// window id: an MCP server started before this change keeps running the old
// code against the shared store for the life of its session (see
// .claude/sessions/common-issues/stale-mcp-server-runs-old-code.md), so a
// window-target row can be written into a store whose other sessions are
// already on the new build. Deleting the branch would make agent_close kill
// nothing at all for those rows - kill-pane against a window id fails - and
// the wrong outcome would be a leaked live process rather than a loud error.
//
// WHAT THAT BRANCH STILL COSTS, ACCEPTED AND RECORDED RATHER THAN FIXED
// (counselors, codex seat). A legacy window-target row whose window has since
// gained a split CHILD takes the child's pane down with it, which is exactly
// the collateral kill the pane id removes. The seat's proposed fix - refuse
// loudly on a multi-pane legacy window and tell the human to restart the stale
// server - was weighed and rejected: it turns agent_close into a failure for
// rows a human cannot repair from inside hive (nothing repoints tmux_target),
// and it would be a NEW refusal on a path that has always killed. This is not
// a regression either: it is main's behaviour for EVERY window-placed worker,
// narrowed to the rows a pre-change server writes.
//
// "A POPULATION THAT CAN ONLY SHRINK" WAS THE FIRST WORDING AND IT WAS WRONG
// (counselors round 2, two seats). An old MCP server keeps running old code
// for the LIFE OF ITS SESSION, so it can spawn NEW window-placed workers after
// this ships, and their panes outlive that server because they belong to the
// long-lived shared tmux session. The population is bounded by how long any
// pre-change session stays open, which is hours, not by this build's own
// write sites. The disposal is unchanged - the trade above does not turn on
// the population shrinking - but the reason had to stop claiming something
// false. Revisit if window-target rows ever become writable by a CURRENT
// build, which would mean this whole change had been reverted.
```

## line 349

```
// Resolve the window before the pane dies, then re-tile the survivors:
// tmux's own redistribution otherwise wipes the arrangement hive applied on
// spawn.
```

## line 355

```
// Todo 269 / counselors F1 on pad 71. The window's OWNER decides its
// hive.yml, never the CLOSING row's project: once a cross-project worker can
// share a window with a lead it did not spawn from (todo 268), re-tiling
// through the closing row's own project lets a foreign repo arrange a window
// it does not own. windowLayout(window) is consulted FIRST and already reads
// @hive-layout off the window itself, so this only narrows the FALLBACK,
// which fires when the window carries no @hive-layout yet. A window with no
// @hive-project-id stamp (a user-created window, or a placement="window"
// worker's own - both deliberately unstamped, test/worker-first-window-
// stamp.test.mjs) has no owner to resolve a layout through either, so
// DEFAULT_LAYOUT is the honest answer there too - never the closing row's
// project, which is the defect.
// SIBLING CALL SITE: agent_spawn's landed_in_project receipt resolves the
// same windowOwner -> getProject pair and handles a stamp naming a DEAD
// project row the other way, with a synthesized "project <id>" placeholder.
// Deliberate, and its own comment carries the argument. Absent is the honest
// answer HERE because the value feeds a layout: a hive.yml read from a
// project that no longer exists cannot be produced at all, so there is
// nothing to fall back to but DEFAULT_LAYOUT.
```

## line 382

```
// Issue #156, D2. THE LANE'S TODOS, DERIVED RATHER THAN RECORDED, and the
// reasoning is the whole of D2's second half (todo 353 comment 819).
//
// The issue asks park to record "the lane's todo and pad ids". A parameter for
// them - in a column, in a blob, or in the board line - reintroduces the exact
// failure the issue was filed about: something the lead has to remember at
// 18:00 on a Friday, whose omission is indistinguishable from a lane that
// genuinely has no todo. `todo_comments.author` is already the row's own
// actor_id, written as a side effect of the worker recording its decisions the
// way the runbook requires, so the link exists without anyone deciding to make
// it. Lane A's D2 (resume reuses the row AND the actor_id) is what keeps it
// stable across park/resume cycles; a design that minted a new actor_id per
// resume would break this on the first one.
//
// IT IS AN INFERENCE AND THE RECEIPT SHOULD NOT PRETEND OTHERWISE. A worker
// that never commented yields nothing; one that commented on a neighbouring
// lane's todo yields a spare id. Both fail toward "a missing or extra number
// on a board line", never toward a lost lane, which is the direction a column
// the lead forgot to fill fails in too - with none of the recall this has.
//
// Scoped to the PROJECT as well as the author: an actor that commented on
// another project's todo (the deliberate cross-project write
// .claude/rules/project-scoping.md describes) is not this lane's work.
// Archived todos are excluded for `hive status`'s own stated reason - a
// board line naming a lane's archived scaffolding is noise at cold boot.
```

## line 420

```
// THE BOARD LINE, BUILT BY THE TOOL RATHER THAN REMEMBERED BY THE LEAD - the
// half of issue #156 Chris actually asked for ("asking the lead to save to the
// board that we should resume these X sessions tomorrow").
//
// IT IS RETURNED, NOT WRITTEN, and that is a decision rather than a shortcut.
// Chris's own sentence describes the lead putting it on the board; what the
// issue calls the failure is the lead having to COMPOSE it from memory, and
// generating the text removes exactly that. Having this tool append to the
// "board" pad itself would add a write to another resource - into free-form
// content whose structure this tool cannot know, at a position it cannot
// choose, in the one area of this store that has had a destructive incident
// (src/db.ts's todo 331 migration). The row is the system of record here (D2),
// `hive status` reports parked lanes from it, and agent_list surfaces them, so
// the board is a convenience rather than the thing park depends on. If that
// turns out to be the wrong call it is one pad_append to reverse, which is why
// it is worth starting on the cautious side.
//
// Wrapped to fit 80 columns because it is pasted into a pad that is read raw
// in a terminal, matching the runbook's own wrapping rule for that content.
```

## line 456

```
// The full agent_park receipt, shared by the ordinary success path and the
// "someone else already parked it first" branch of the lost-CAS report
// below: both describe a row that IS parked, one because this call parked
// it and one because a concurrent agent_park won the race, and a caller
// reading the receipt needs the same facts either way. `note` is the one
// field that tells them apart.
```

## line 489

```
// The message matters as much as the refusal. Told a worker has no window, a
// model follows the instruction and closes it; told the probe failed, it
// retries. Never hand out the first when we mean the second, and say it the
// same way everywhere it is said.
```

## line 512

```
// Names are the handle leads address workers by, so two running agents may
// never share one: findAgent would go ambiguous and every name-addressed call
// would need an id instead. Enforced at both doors, spawn and rename.
//
// Compared case-insensitively, because that is how partial resolution matches.
// "impl" and "Impl" are not two handles: every partial match finds both and
// reports them as ambiguous, so allowing the pair would hand a lead two
// workers it can only ever address by id.
//
// Folded in JS with the same toLowerCase findAgent uses, deliberately, rather
// than in SQL. SQLite's NOCASE folds ASCII only, so the two engines disagreed
// outside ASCII: "café" and "CAFÉ" passed this check as different names and
// then collided at resolution, producing the exact pair this exists to
// prevent. One rule needs one implementation.
// The one query requireNameFree and agent_resume's own collision message
// both need: which RUNNING row, if any, already holds this name. Split out
// (todo 364, /simplify altitude pass) because requireNameFree's OWN refusal
// ("Pick another name") is impossible advice for a resume - the whole
// reported bug ("Park 'impl', spawn a fresh 'impl', try to resume the
// parked one: told to pick another name, but resume does not take one") -
// so a caller-specific message for one caller out of three does not belong
// growing requireNameFree's own signature. Pure and throwless on purpose:
// the two callers below decide what a collision MEANS for them.
```

## line 550

```
// Issue #27's L4 fix round, DECISION 7c. "lead" is reserved, not merely
// usually taken: ensureLeadRow (src/cli.ts) inserts the lead's own row
// directly, never through this door, so a worker could take the name the
// moment no lead row is running (a fresh clone, or between a lead session
// ending and the next `hive lead`). The next `hive lead` would then INSERT,
// hit SQLITE_CONSTRAINT_UNIQUE on idx_agents_running_name, and throw out of
// ensureLeadRow BEFORE ensureSession or attach - the lead does not start,
// and nothing about that failure names a worker as the cause.
//
// Not re-checked at agent_resume's own call site below: a kind='agent' row
// can never legitimately be named "lead" (this check already refused it at
// spawn and at rename, its only two doors), and agent_resume refuses any
// kind='lead' target before it ever reaches a name check at all - so this
// branch is unreachable from resume by construction, not merely untested.
```

## line 573

```
// Counselors (fable): agent_spawn's auto-generated --session-id used to be
// injected unconditionally for a claude command, on the reasoning that a
// duplicated flag gets claude's own last-flag-wins behaviour. That reasoning
// does not reach this case: --session-id and --resume/--fork-session are
// DIFFERENT flags, not two copies of the same one, so there is no
// duplicate for claude's parser to resolve between - what actually happens
// with both present is unverified. The pre-#154 manual resume workflow
// (.claude/sessions/workflows/resume-a-closed-worker.md) is exactly
// `agent_spawn(command: "claude", extra_args: ["--resume", "<id>"])`, still
// documented and still callable, so this has to keep working rather than
// silently gain a second, conflicting flag.
```

## line 594

```
// A name is not just a label: it gets typed into a terminal, as the pane
// announcement at spawn and as /rename on a live worker. `tmux send-keys -l`
// stops tmux interpreting key NAMES, but it passes a raw control byte
// straight through to the TUI, so a name carrying 0x03 sends Ctrl-C into a
// worker mid-task. Verified directly against tmux rather than reasoned about:
// send-keys -l -- with a literal 0x03 interrupts a running foreground
// process. Both doors validate, because both doors type.
//
// findUnsafeControlChar is the same detector issue #150's wake/agent_send
// text guard uses (src/tmux.ts); a name passes no exceptions, unlike that
// guard's tab/newline allowance, because a name has no legitimate newline.
```

## line 626

```
// How long agent_spawn waits for claude's prompt box before returning. A cold
// claude loading plugins and MCP servers routinely needs more than ten
// seconds, and an observed 8s default missed the prompt box outright.
// Waiting costs one tmux fork per 500ms, so the ceiling is generous on
// purpose: a slow start should delay the return, not silently lose whatever
// the caller does next.
//
// THIS WAIT OUTLIVES THE ANNOUNCEMENT IT WAS ADDED FOR (todo 387 fix round
// 1, finding 1). Todo 387 stopped typing anything into a fresh pane, and the
// first version of that change removed this wait along with the typing it
// used to gate - reasoning that with nothing left to type, there was nothing
// left to wait for. That reasoning missed what the wait actually protects:
// waitForPaneInput's own contract is that sending into a pane that has not
// taken the terminal loses the text silently and reports success
// (src/tmux.ts). Removing the wait did not remove that hazard, it moved it
// onto the NEXT thing to type into this pane - which is now the lead's own
// agent_send, landing straight after agent_spawn returns for exactly the
// dispatch shape todo 384 measured (spawn and send in the same tool block).
// Without this wait, that send races a cold claude and can be silently
// swallowed while reporting sent: true - strictly worse than the false-finish
// defect this whole lane exists to fix, and reportUnbriefedWorkers cannot
// catch it either, since resumed_at is no longer stamped at spawn to detect
// against. Keeping the wait closes the window at the one place hive still
// controls it: agent_spawn does not return until the pane can safely be
// typed into, even though agent_spawn itself types nothing.
```

## line 653

```
// Two of the three ways in can end in unknown: an omitted snapshot probes
// this row on its own and may get no answer, and a null snapshot means the
// batch probe already failed. A snapshot that was passed always answers.
// Unknown is reported as alive: null with the row exactly as the store has
// it, rather than inventing "exited" for a worker that is very likely still
// running (issue #14).
```

## line 660

```
// A closed row needs no probe: the store already answered, and reporting it
// as unknown during a hiccup would make a definitely-dead worker look like
// it might still be there.
```

## line 669

```
// Issue #34. A SEPARATE capture from the tail/output, not derived from it:
// counselors review on PR #37 overturned an earlier fused single-capture
// version of this (see git history) after two independent findings. First,
// capturePane's plain "-p" tail and a "-e" capture are not just differently
// formatted, they can DISAGREE on which rows are blank: tmux's "-e"
// serializer also emits OSC 8 hyperlinks and SO/SI charset controls that
// stripSgr's SGR-only regex does not strip, so a visually-blank row carrying
// one of those reads as non-empty under the fused function's trimming and
// gets kept, while capturePane's plain-text trim on the same row correctly
// drops it -- the two "same screen" contracts silently diverge by a row.
// Second, agent_output's capped lines can reach 200, and "-e" widens every
// attributed cell, which can push a single capture past execFileSync's
// default maxBuffer and throw ENOBUFS -- for agent_send's wait_ms path,
// AFTER the text was already sent, turning a successful send into a
// reported error. Two forks is the correct cost here, not one.
//
// UPDATE, topology-3c: the second (ENOBUFS) leg is no longer load-bearing on
// its own -- tmux() (src/tmux.ts) now passes TMUX_MAX_BUFFER (16MB) to every
// call, this one included, so the DEFAULT maxBuffer these two captures used
// to risk is not what either one runs under any more. The FIRST leg (the two
// serializers disagreeing on which rows are blank) is untouched and is
// sufficient on its own to keep this split: merging the two captures back
// into one would still silently break the row-blankness property, with
// nothing here to catch it.
//
// Present only when a recognisable input-box line was found: an absent
// field is a plain "nothing to say" (slim receipts), not a claim that the
// box is empty.
```

## line 702

```
// Issue #5 (transcript_dir) and issue #154, D4 (session_id): two facts that
// share one inclusion gate, so they are one field function rather than two.
// isClaudeCommand is the gate both need - codex or aider have neither a
// transcript directory nor a session id, and must not get a confidently
// wrong value for either - and both are called at the identical two sites
// below, so splitting them would only add a duplicated ternary at each call
// site (as it once did) for no discrimination anything actually uses.
// Contrast lastLogEventField/paneField further down, which stay two
// functions because their gates genuinely differ.
//
// transcript_dir: resolution is purely a function of the stored cwd string
// (D7) - recreating a removed worktree at the same path makes `claude
// --resume` work there again, since Claude Code keys its transcript
// directory on cwd alone.
// session_id: '' is "no fact recorded" (the same convention tmux_socket and
// pane_pid already use) and is reported as null here so a caller does not
// have to know that convention to read the field.
//
// Callers decide WHEN to call this, the same way they already decide when
// to call inputBoxField, rather than this function carrying an inclusion
// policy of its own beyond the one isClaudeCommand gate.
```

## line 731

```
// Issue #72. Two more reports, neither derived from agent_state/provenance
// above: a worker whose latch and log genuinely stopped moving reads the
// same in `provenance` whether it is dead-in-the-water or perfectly healthy
// and just quiet, because provenance only ever shows the row that explains
// the CURRENT latch. These make that condition VISIBLE and worth a second
// look, reported raw, with no verdict attached. Fix round 1, item 7: this
// used to claim they are "what a reader actually needs to tell those apart",
// which overclaims -- two workers with the same prompt|working row and
// identical "running tool" screens, one waiting on a slow tool and one
// SIGSTOPped, produce byte-identical last_log_event and pane. They do not
// distinguish those two states; this lane's own rule is report, do not
// infer, and a field that actually discriminated every cause would be doing
// the inferring. Two functions, not one, matching inputBoxField above: each
// field owns exactly one inclusion gate, and the two gates here are
// genuinely different (reportsAgentStateLog vs. liveness) - unlike
// claudeOnlyFields above, whose two facts share one gate and are fused for
// exactly that reason.
//
// last_log_event: the actor's log, independent of whether the latch moved
// (stateProvenance.ts's lastLogEvent -- see its own comment for why this is
// not the same question deriveProvenance answers). Gated on
// reportsAgentStateLog (stateProvenance.ts): present (possibly null) for a
// claude worker, absent for anything else, since a lead or a non-claude
// command never writes this log the way #72 means it (worker-state.md).
```

## line 759

```
// pane: what the pane shows right now -- describePaneChoice's own three-value
// vocabulary (src/tmux.ts), the same words `hive doctor` renders, so the two
// surfaces cannot drift onto different spellings of the same fact. No tail
// here (fix round 1, item 2): a tail on every alive claude row made agent_list
// -- the hottest read tool -- pay ~1KB/row against CLAUDE.md's "token cost is
// a design input" to save one agent_output call in the rare dialog case, the
// wrong trade for a list response. A lead that sees `pane: "awaiting a choice
// (dialog)"` calls agent_output or agent_status for the tail, which is what
// those tools are for.
//
// AGENT_LIST ONLY, deliberately not folded into agentSummary (fix round 1,
// item 2): agentSummary is shared with agent_status, which already captures
// its own, separately-timed pane snapshot (capturePane + inputBoxField,
// below). A pane field riding along inside agentSummary would be a SECOND,
// older capture of the same pane sitting next to agent_status's own -- if a
// dialog clears between the two captures, one response would carry
// `pane: "awaiting a choice (dialog)"` next to a top-level tail that shows no
// dialog at all. Call this only from agent_list's own row-mapping, using the
// `alive` agentSummary already computed for that row.
//
// This is the one place in this file that spends a capture-pane fork on
// every alive claude row, inside rows.map()'s unbounded loop -- one call per
// row, synchronous, no timeout, so an unresponsive tmux server hangs
// agent_list for as long as that row's fork takes, times however many alive
// rows come before it. The D3 comment on transcript_dir above warns against
// growing the alive-worker path for a payload-size reason; that half no
// longer applies here now that the tail is gone (this field is a few
// bytes). The LATENCY half is real and is not new: liveTargets(), a few
// lines above this field's own call site, already forks tmux unconditionally
// on this exact call path with no timeout of its own, so an unresponsive
// tmux server already hangs agent_list today, before this field exists. What
// this field adds is latency proportional to the number of ALIVE claude
// rows, on top of that pre-existing single fork -- and capture-pane has no
// batched form to call instead of one fork per row, the way liveTargets()
// batches liveness. Accepted deliberately: this project runs at most a
// handful of workers, so N sequential forks on top of the one hive already
// pays is not worth a batching scheme for.
```

## line 804

```
// `state` is dropped from the nested object below and used directly as
// agent_state instead: deriveProvenance already applies the "gone" override
// when alive is false, so re-deriving it here with a second ternary would
// be the exact kind of duplicated special case this module exists to kill
// (a caller must trust the derivation's own answer, not recompute it).
```

## line 820

```
// last_log_event only -- SQL-only, cheap, and useful on both surfaces
// that build on this shared summary. pane is NOT here; see paneField's
// own comment for why it stays agent_list-only.
```

## line 824

```
// Issue #156. Present only on a row that was actually parked, so a caller
// reading agent_list(include_closed: true) can tell a paused lane from a
// finished one - the distinction the issue says a next-morning lead cannot
// make today, since `closed` currently means both. Absent rather than null
// for an ordinary close, matching the slim-receipt convention every
// conditional field on this summary already uses: '' is "no fact
// recorded", and a reader should not need to know that to read this.
```

## line 840

```
// Todo 406. `git worktree add` leaves a fresh worktree with none of the
// primary checkout's installed dependencies, and nothing in hive's shipped
// workflow ever verifies an install ran before a lead spawns a worker into
// one - `npm run build` even reports success anyway, because node's module
// resolution walks UP from the worktree into the primary checkout's
// node_modules and finds tsc there. Detection only: this never runs the
// declared command, never blocks or retries the spawn, and never guesses
// one - the project already declares it in hive.yml's `vars.install`, and
// inferring one from package.json or any other ecosystem file is exactly
// the guess todo 406 rules out by name ("do not have hive infer the install
// command from the ecosystem").
//
// UNCONDITIONAL ON A LINKED WORKTREE, DELIBERATELY, RATHER THAN CHECKING
// WHETHER THE INSTALL ALREADY RAN. "Installed" has no generic definition
// this function could check for: `vars.install` is an opaque string that
// could be `npm install`, `composer install`, `bundle install`, each with a
// different marker (node_modules, vendor, Gemfile.lock) hive has no
// business knowing about - checking for one would be exactly the ecosystem
// sniffing ruled out above, aimed at a different question. A lead who
// re-spawns into a worktree it already installed gets a redundant one-line
// notice; a lead who spawns into a fresh one gets the one that matters. The
// asymmetry favors the redundant note: a slim, always-true line a lead
// learns to skip costs far less than the silent miss this todo was filed
// over.
//
// COUNSELORS ROUND, FIX 1. `config?.vars?.install` is trimmed before the
// emptiness check and before it is returned: projectYml.ts coerces every
// YAML scalar with String(), so a value with NO NON-WHITESPACE CHARACTERS
// (an all-whitespace string, or an install key present but blank) reads as
// truthy to a bare `!install` check and used to ship a present-but-blank
// `worktree_install` field - a slim-receipt violation of a different shape
// than an absent one. This is a syntax check only, not a semantics one: it
// does not ask whether the trimmed text is a SENSIBLE command (that stays
// the caller's problem, same as `install: false` reading as the literal
// string "false") and does not reopen the "install is an opaque string hive
// has no business interpreting" decision two paragraphs up, which is about
// what the string MEANS and still stands.
//
// COUNSELORS ROUND, FIX 2. `cwd`'s own linked-worktree primary root must
// equal `projectPath` - the project whose hive.yml is actually supplying
// `config` - or this says nothing. Without this, a linked worktree of an
// UNRELATED repo sitting inside a registered project's own directory tree
// (project-scoping.md's own accepted containment residual;
// test/spawn-cwd-scope.test.mjs case (h) pins the precondition) resolved to
// the containing project for STORE purposes, and this function printed the
// CONTAINING project's install command against a cwd whose real files
// belong to a different repo entirely - hive's own `npm install && npm run
// build` offered for a worktree of, say, someone's PHP project.
// `findProjectForDir(cwd)` was considered for this comparison and measured
// wrong: it is the SAME containment-aware resolution that produces the bug
// in the first place, so `findProjectForDir(cwd)?.id === project.id` is
// true in exactly the case it needs to catch (verified against case (h)'s
// own fixture - both resolve to the containing project's id). This project
// already states the reason as an invariant: files come from cwd, the
// store comes from the project row, and they are separate questions
// (project-scoping.md). `linkedWorktreePrimaryRoot` answers the FILES
// question with no containment involved - literally which repository cwd's
// worktree belongs to - which is the fact this comparison actually needs.
```

## line 948

```
// The worker resolves its own scope from this cwd at runtime
// (src/context.ts's detectFromCwd), independent of what project
// this spawn resolved above. An unregistered cwd is the ordinary
// case (a worktree matches by git primary root; a scratch
// directory belongs to nobody) and stays allowed. Only refuse when
// cwd names a DIFFERENT project that is already registered: a
// caller who means it passes project_id for the cwd's project.
```

## line 957

```
// project_id is the deliberate escape hatch, but only an
// unlocked caller (a lead) can use it: assertAccessible refuses
// any project_id but the home one under HIVE_PROJECT_LOCK=1, so
// a locked worker told to "pass project_id" would just get a
// second, unrecoverable refusal. Tell it the truth instead.
```

## line 978

```
// Issue #154, D1. Generated here rather than left to the hook to
// discover, so the id is known at spawn time and correct even for a
// worker that dies before its first hook fires - src/hook.ts
// reconciles from the payload afterward, which is what makes this
// flag non-load-bearing rather than redundant (see its own comment,
// and the migration in src/db.ts). '' for a non-claude command (D4's
// gate, since codex or aider have no such id) and for a caller
// already requesting --resume/--fork-session in extra_args (see
// requestsExistingSession's own comment).
```

## line 988

```
// The brief names the agent, so it can only be written once the row
// exists; launchAgent calls this back with the ids it just allocated.
```

## line 999

```
// Repo-controlled text, rendered into this worker's system prompt.
// See the hive.yml note in CLAUDE.md: a cloned hive.yml deserves the
// same read as the repo's own CLAUDE.md.
```

## line 1012

```
// --session-id first when generated, caller-supplied extra_args
// after: sessionId is already '' (skipped) for a caller
// requesting --resume/--fork-session, so this never doubles up
// on those flags - see requestsExistingSession's own comment for
// why that pair cannot rely on claude's last-flag-wins behaviour
// the way an actually-duplicated flag (e.g. two --session-id)
// could.
```

## line 1048

```
// NOTHING IS TYPED INTO THE PANE (todo 387, option (e)). This used to
// type a `[hive]` line and submit it, which created a real turn hive
// asked for itself - and everything downstream was machinery for
// managing that turn: the spawn half of agents.resumed_at,
// SPAWN_ANNOUNCEMENT_PREFIX, isSpawnAnnouncement, and a busy pane
// absorbing an assignment into that turn with no UserPromptSubmit to
// clear the latch, silencing the worker for the rest of its life.
// Every fact that line carried is already in the brief riding the
// system prompt (--append-system-prompt-file); the one thing it added
// was an instruction ("wait for your assignment"), which now lives in
// the brief text itself (src/brief.ts). A human attaching to a fresh
// pane sees an idle claude with nothing on screen until the lead
// sends - accepted, not a correctness cost.
//
// THE WAIT STAYS, EVEN THOUGH THE TYPING IT ORIGINALLY GATED IS GONE
// (fix round 1, finding 1). See PANE_READY_MS's own comment for why:
// this is no longer about protecting agent_spawn's OWN send, it is
// about not returning until the NEXT send - the lead's own
// agent_send, which can land in the same tool block as this call -
// is safe to type into. The dialog check rides along for the same
// reason it always did: reported information a caller can act on
// (agent_send keys to clear it) rather than a gate on anything hive
// itself does here.
```

## line 1083

```
// Pane died or tmux refused; the receipt reports it below.
```

## line 1093

```
// Todo 268: a caller cannot reconstruct where a pane landed from
// project_id alone - THE PLACEMENT RULE (pad 71) puts a split
// worker's pane in its spawning lead's window, which is a
// different project's window whenever that lead is orchestrating
// cross-repo work. Slim: omitted whenever the pane landed in this
// worker's own project's window, which is the ordinary case.
// SIBLING CALL SITE, and it answers the stale-stamp case
// DIFFERENTLY on purpose: agent_close's re-tile (further down this
// file) also resolves windowOwner -> getProject, and when the stamp
// names a project row that no longer exists it treats the owner as
// ABSENT and falls to DEFAULT_LAYOUT. Here the same state
// synthesizes a placeholder name instead. Both are right for their
// own question - a reader wants to be told SOMETHING about where the
// pane went, while a layout resolved from a project that no longer
// exists would be a guess dressed as a fact. Named in both places
// rather than unified behind one helper (/simplify review, 3b):
// sharing the lookup would not share the policy, and the policy is
// the part that differs. The state itself is near-unreachable -
// project_prune refuses a project that still owns rows, and a
// stamped window's project owns at least the agents row of whatever
// is running in it.
```

## line 1117

```
// The lead has no other channel to learn its hive.yml is malformed:
// loadProjectYml already fell back to a default, so the spawn looks
// clean. Reported, never fatal, and omitted when there is nothing to
// say (slim receipts).
```

## line 1122

```
// Todo 406: cwd is a linked worktree and hive.yml declares an
// install command - said once, unconditionally, never executed.
// See worktreeInstallNotice's own comment for why this does not
// try to tell an installed worktree from a fresh one first.
```

## line 1130

```
// Renamed from the pre-todo-387 `announced` (fix round 1,
// finding 2/3): this reports whether the pane took the
// terminal cleanly, not whether hive typed anything into it -
// nothing does anymore. `false` here is exactly the signal
// callers (scripts/part-c-gate.mjs, a lead deciding whether
// to send yet) need before their own first send: the pane may
// still be mid-boot or sitting on a dialog agent_send would
// refuse or silently lose text against.
```

## line 1172

```
// agent_resume is for workers; a lead's restart path is `hive lead`
// (ensureLeadRow, src/cli.ts), which already reuses its row and
// actor_id the same way D2 has this tool do for a worker - a second,
// unrelated mechanism for the identical row, not a gap.
```

## line 1195

```
// ISSUE #156: A REMOVED WORKTREE, REFUSED HERE WITH THE ONE FACT THAT
// REBUILDS IT, rather than surfacing as tmux's own failure or, worse,
// as an ENOENT naming a binary. Node reports a spawn whose cwd is gone
// as ENOENT against the EXECUTABLE, not against the directory
// (.claude/sessions/common-issues/enoent-names-the-binary-when-the-
// cwd-is-gone.md, measured 2026-08-11), which sends the reader after
// PATH, the interpreter pin and the dispatcher - three dead ends this
// project has a real, similar-looking failure class in.
//
// The remedy is reachable precisely because park recorded the branch
// (D2): transcript resolution is a pure function of the cwd string
// (issue #5 D7), so recreating the worktree at the SAME PATH on the
// SAME BRANCH restores resumability completely. That is the whole
// return on the parked_branch column, and it is why park records a
// fact instead of refusing to let anyone remove a worktree.
//
// Checked for any closed row, not only a parked one: a resume into a
// missing directory fails the same way whichever it is. A row with no
// recorded branch says so rather than inventing one.
```

## line 1223

```
// A BRANCH THAT MOVED IS REPORTED, NOT REFUSED. The session resumes
// from the cwd string alone, so a different branch under the same path
// is a working resume into a lane whose code has changed - worth
// saying out loud on the receipt, and not worth blocking, since
// resuming a lane onto a rebased or renamed branch is an ordinary
// reason to resume at all. Silence is the failure mode to avoid here:
// a resumed worker's own context still describes the branch it was
// parked on.
```

## line 1236

```
// Counselors (opus): idx_agents_running_name's COLLATE NOCASE folds
// ASCII only, so it alone would let a resumed "café" and a running
// "CAFÉ" both stay running - the exact pair requireNameFree exists to
// refuse for a fresh spawn, folded in JS for that reason. The closed
// row this call resumes was never checked against it (findClosedAgent
// only excludes RUNNING rows by name, not closed ones), so this is
// the resume path's own equivalent call, not a redundant one.
// resumeAgent's own SQL-level catch (src/spawn.ts) is the backstop
// for the TOCTOU race between this check and its write, the same
// two-layer shape launchAgent + asNameClash already use.
//
// Todo 364. runningAgentNamed, not requireNameFree: this call's own
// message, not the generic "Pick another name" - see
// runningAgentNamed's own comment for why that split exists.
```

## line 1266

```
// No brief file and no pane announcement here, unlike agent_spawn:
// the resumed session already carries its original brief and its
// prior conversation in its own transcript, and typing an
// assignment into the pane is lane B's job (issues #154/#156's plan
// pad), not this tool's - it hands back a live pane and lets the
// caller send the next instruction with agent_send.
//
// Counselors (all three seats): this used to hardcode command:
// "claude", discarding the original binary path a caller may have
// spawned with (e.g. an absolute path needed because a bare `claude`
// does not resolve on the pane's PATH - the exact class
// .claude/rules/tmux-and-panes.md documents for iTerm's own minimal
// PATH). The binary is recovered from the closed row's own recorded
// command, the one fact this tool has about how it actually ran.
// --model and any other extra_args (permission mode, --add-dir, ...)
// are NOT recovered - hive does not record them separately from the
// command string they were folded into, and re-parsing arbitrary
// flags out of that string is its own hazard. This is the same
// "settings can drift on resume" limitation
// .claude/sessions/workflows/resume-a-closed-worker.md already
// documents for the brief; recorded here as a known residual for the
// same reason, not silently reintroduced.
//
// A plain string, not a callback: agent.id and agent.actor_id are
// already known here, unlike agent_spawn's buildCommand above, whose
// callback shape exists because launchAgent's ids do not exist until
// its own INSERT runs.
```

## line 1316

```
// ACCEPTED RESIDUAL, todo 365. This receipt can name a session that
// has already exited by the time the caller reads it: `claude
// --resume <id>` against a transcript that is gone (pruned past
// Claude Code's own cleanupPeriodDays, default 30 - measured against
// the installed binary, not assumed) errors loudly ("No conversation
// found with session ID: <id>", exit 1) within about a second, and
// nothing here sets tmux's remain-on-exit, so the pane closes right
// behind it. Accepted rather than pre-flighted, because the failure
// is loud and SELF-CORRECTING: isLive/agent_status/agent_list all
// read the row fresh on their own next probe, and the janitor sweeps
// it within its normal cadence regardless. A one-second window where
// a receipt can be stale is a different animal from a row that reads
// running forever over a dead pane - which is the shape this whole
// lane exists to refuse. REOPEN TRIGGER: `claude --resume` ceasing
// to error loudly on a missing transcript (empty session, or a fresh
// one) would turn this from "corrects itself in a beat" into exactly
// that shape, and would need a pre-flight transcript check here.
```

## line 1339

```
// Issue #156: tells a parked resume from an ordinary one on the
// receipt itself, so a lead resuming a morning's crew can see which
// of them it actually parked last night and which were merely
// closed. Absent, not false, when the row was never parked - the
// same "no fact recorded" convention the column itself uses.
```

## line 1353

```
// ISSUE #156. THE RETIRE CELL OF .claude/rules/tool-contract.md's LIFECYCLE
// MATRIX, which read "n/a, folded into agent_close" for agents until this
// tool. That rule defines Retire as "soft, reversible, still readable by id
// afterward" and Remove as "hard, permanent"; park is the first and
// agent_close is the second, so this is not a new slot invented for it.
//
// WHY A TOOL AND NOT A `park` BOOLEAN ON agent_close (the issue names both).
// Written without naming that parameter in a callable shape on purpose:
// test/wire-surface.test.mjs reads every tool call in this source and
// requires its parameters to be real, so a rejected design spelled out as a
// call reads to that check as a tool this file suggests. A boolean that
// verb MEANS makes one description answer for two operations, and
// agent_close's refusals - the live-lead refusal, the worker-caller gate -
// carry reasoning about ENDING a lane that was never made about pausing one.
// The naming rule's own escape hatch covers the verb: Retire defaults to
// `<resource>_archive` and may take a domain verb when retirement does more
// than flip a row, which killing a live pane is - the same reason
// `agent_close` overrides Remove.
```

## line 1387

```
// A LEAD IS NEVER PARKED, refused before anything is probed or killed.
// agent_resume already refuses a lead on the other side (its restart
// path is `hive lead`, which reuses the row and actor_id by its own
// mechanism), so a parked lead would be a row nothing could ever
// un-park - the state this tool exists to make legible would be the
// one state with no way out of it.
```

## line 1399

```
// PARK PROMISES RESUMABILITY, SO IT REFUSES WHAT IT CANNOT RESUME.
// Both conditions below are exactly agent_resume's own, checked here
// rather than only there, because the cost of learning it tomorrow
// morning is the whole lane: a row marked parked is a promise the
// next-morning lead reads off `hive status` and plans around, and
// discovering at 09:00 that the promise was empty is worse than being
// told at 18:00 to use agent_close instead. Same facts, twelve hours
// earlier, when there is still a live pane to do something about.
```

## line 1420

```
// THE THIRD OF agent_resume's PRECONDITIONS, and the one this tool
// originally left out - found by this lane's own /simplify altitude
// pass, which is the shape of mistake the pass is for: park's promise
// had quietly outlived resume's requirements INSIDE THE SAME COMMIT
// that added the requirement.
//
// What it costs when it is missing is exactly the case parked_branch
// was built for. Park a worker whose worktree was already removed out
// from under it (which the lead did to a running worker on
// 2026-08-11): the park succeeds and marks the lane resumable,
// branchAt has nothing to read so it records '', the board line says
// "branch (unrecorded)", and next morning agent_resume refuses with
// advice telling you agent_park would have recorded a branch - which
// it did run, and could not. Unactionable, and false.
```

## line 1442

```
// Unknown liveness is never dead (issue #14), the same refusal
// agent_close makes one tool down and for the same reason: parking the
// row while the pane may still be up leaks a running process nothing
// tracks, and the kill would not land anyway while tmux is unreachable.
```

## line 1452

```
// READ THE BRANCH BEFORE THE PANE DIES. Nothing here depends on the
// pane, but a park whose kill throws must not have already stamped the
// row, and a park that stamped the row must have the branch: doing the
// read first keeps both true whichever way the kill goes.
```

## line 1458

```
// The same conditional write agent_close makes, for the same race: a
// concurrent writer recording a fresh pane on this row between the
// probe above and this write must not have its row retired on the
// strength of a probe that is no longer true.
```

## line 1464

```
// Todo 369. This call may already have killed a live pane above -
// that cannot be undone by a lost CAS, and the message must not
// pretend otherwise. Re-read the row (classifyLostCas's own
// comment) rather than assume "nothing happened".
```

## line 1472

```
// A concurrent agent_park already parked this exact row -
// the caller's goal was reached, just not by this call.
```

## line 1483

```
// Closed, but not as a park: an ordinary agent_close (or the
// janitor) won the race instead. The end state is NOT what this
// call promised - no branch was recorded through this path, so
// resuming it may not work the way a park would have set up.
```

## line 1502

```
// The one fact a slim receipt cannot leave to the caller to
// reconstruct (.claude/rules/tool-contract.md): the board_line IS the
// deliverable half of issue #156. Paste it onto the board.
```

## line 1527

```
// Issue #27's L4 fix round, DECISION 4/5. "lead" is the name every
// wake, pad and todo comment addresses this project's lead by, and
// ensureLeadRow (src/cli.ts) now keys its own lookup on kind='lead' +
// running rather than on the name - so a rename would not even strand
// the identity, it would let the NEXT `hive lead` mint a second one
// under the freed name while the renamed row goes on being the real
// lead under a name nothing points at any more. Refuse outright,
// defence in depth alongside the kind='lead' keying: the message is
// what a human or lead actually needs here, a silent non-strand is not.
```

## line 1542

```
// Reachable only by id: name lookups already filter to running agents.
// Renaming a closed one changes a label nothing can address and
// rewrites the actors row for a worker that is gone.
```

## line 1551

```
// Unknown counts as not-live here, and that is safe: everything it
// gates is cosmetic (the tmux window title, claude's own /rename), so
// the worst case is a pane label that lags the store until the next
// rename. The row itself is renamed either way.
```

## line 1556

```
// A worker that has a window of its own carries its name in that
// window's title too, which is hive's own to set. WHICH workers those
// are is renameAgent's question now, not this call site's, and it
// answers it by asking the window rather than by reading the KIND of
// id in tmux_target - see ownsItsWindow (src/spawn.ts, todo 371).
// Every row records a pane id now, so the old `!isPaneTarget(...)`
// test here answered "no" for every worker in existence.
```

## line 1565

```
// claude owns its pane title and rewrites it as the session moves, so
// hive cannot set it directly and make it stick. /rename is claude's
// own way of pinning it, and typing into the pane is the channel hive
// already drives workers through.
//
// Issue #27, decision D1. This is a synchronous tool call with a caller
// standing right there, not the scheduler, so it refuses rather than
// holds: a modal pane gets a receipt saying so, not a retry loop. The
// row is renamed either way; only the /rename keystroke is skipped,
// since /rename typed at a dialog would answer the dialog instead.
```

## line 1580

```
// Todo 317, found by the lane's own /simplify altitude pass rather
// than by the capture that opened it. This path cannot reach the
// LEAD - the kind='lead' refusal above throws before any typing -
// which is what made it look exempt. It types into a live WORKER
// pane, and a human attached to a worker pane is ordinary: the
// `lessons` pad's "unsubmitted pane text has happened three times"
// is about worker panes specifically.
//
// THE FAILURE IS WORSE HERE THAN A PLAIN MERGE, which is why this
// is worth a fork on a rare call. A slash command only executes
// when it starts the line. Pasted onto a half-typed sentence,
// "/rename foo" is submitted as ordinary prose along with whatever
// the human was writing: the human's unfinished text goes as a
// message, the retitle silently does not happen, and this function
// still returns retitled: true. The receipt lies about the one
// thing it exists to report.
//
// Same predicate and same narrowness as agent_send's, and it reuses
// this path's existing refusal shape (heldNote/heldTail/retitled
// false) rather than adding one - the row is still renamed either
// way, exactly as it is for the dialog case; only the keystroke is
// skipped.
```

## line 1608

```
// "rename again" has to name the NEW name, not the one the caller
// typed: renameAgent already ran, so the old name resolves to
// nothing and a caller retrying its original call gets "no agent
// named <old>". requireNameFree excludes self, so renaming a row
// to the name it already has is allowed and is exactly the
// retry that retitles the pane. Counselors caught this in
// passing on todo 317; the dialog branch above has never had the
// problem because it says nothing about retrying.
```

## line 1620

```
// Todo 418, sibling of todo 414's fix for agent_send's identical
// paste-then-Enter split (src/tmux.ts's sendText). onPasted fires
// the instant the paste call returns, before the Enter is ever
// attempted, so a throw reaching the catch below can tell
// "nothing landed" from "the /rename text is stranded on screen"
// instead of asserting the former unconditionally, which is what
// this catch used to do.
//
// A NOTE, NOT A THROW - unlike agent_send's fix, deliberately.
// agent_send carries arbitrary caller text, and its own next call
// is the thing most likely to merge onto a stranded fragment, so
// todo 414 rewrote that failure into a throw a caller cannot
// silently ignore. agent_rename sends one fixed, short command to
// a claude pane only (isClaudeCommand, above), and a retry is
// already refused on both paths that could send one:
// holdsHumanInput above catches it on the next agent_rename, and
// agent_send's own text path refuses on the same predicate. The
// merge is already guarded; only the receipt's truthfulness was
// missing, so this reuses the existing heldNote/heldTail shape
// rather than adding a second failure mechanism next to it.
```

## line 1653

```
// Pane died between the failed Enter and this read.
```

## line 1656

```
// else: pane died between the liveness check and the
// keystrokes; the rename itself already landed in the store.
```

## line 1692

```
// Only present when the probe failed, so an empty list from a
// reachable tmux still reads as the plain "no agents" it is.
```

## line 1699

```
// D3: only for a row that is not confirmed alive -- a closed row, a
// running row whose pane is gone, or one tmux could not be asked
// about (alive === null). Omitted entirely for a live worker: the
// common call here is against running workers, and that response
// must not grow a long path per row for a worker whose terminal is
// one agent_output away. The unknown case counts as "not confirmed
// alive" on purpose -- a failed tmux probe is exactly the moment
// agent_output stops answering, so it is where the transcript is
// what is left, not a case to withhold it from.
```

## line 1713

```
// agent_list only -- see paneField's own comment for why this
// is not inside agentSummary (agent_status must not get a
// second, independently-timed pane snapshot).
```

## line 1746

```
// agent_status is the tool a lead polls before acting on one worker,
// so it must not answer "exited" when it means "I could not ask".
```

## line 1751

```
// The path, not the text, by default: status is polled and the
// brief is a kilobyte the caller usually already knows. Stat it
// rather than reading it to find out whether it is there.
```

## line 1758

```
// D2: always present for a claude worker here, unlike agent_list's
// D3 gating -- this is the single-agent query a lead reaches for
// once a pane is already gone.
```

## line 1777

```
// The bound is the one this tool's own description already states,
// "(250-10000)". Before zod 4 the schema said {"type": "integer"} and
// the handler clamped, so the wire carried two range statements that
// disagreed; after zod 4 it advertised +/-9007199254740991 and made the
// disagreement wider. Declaring the real domain is what makes the
// description enforceable instead of aspirational. See src/tools/params.ts.
```

## line 1794

```
// Issue #27, decision D2. text and keys are guarded asymmetrically ON
// PURPOSE, not by oversight. text means "inject a user turn": a modal
// pane has nowhere to put the paste and drops it, then reads the
// trailing Enter as picking the highlighted option, so hive would be
// answering the dialog with the wake's own text. keys means "drive
// this TUI deliberately", and pressing Escape or an arrow key to
// answer or dismiss a dialog IS the legitimate use of it: the lead
// used exactly this to clear a folder-trust prompt and unstick a
// worker on 2026-07-29. Guarding keys would remove the only supported
// way to get a pane like that moving again.
//
// BUT that escape-hatch argument is about a SUPERVISOR unsticking a
// SUBORDINATE's TUI, and does not reach the lead: nothing supervises
// it, the same premise agent_close's own refusal rests on (below).
// Without a kind check here, any worker could type C-c C-c (or C-d)
// at "lead" and end its session exactly as effectively as the
// agent_close this lane already refuses - with no dialog guard, no
// confirm_self, and no kind check of its own (issue #27's L4 fix
// round R6, todo 169; counselors opus F3). Refused only when the
// CALLER is not itself a lead: a peer lead keeps the hatch, for the
// multi-lead direction this lane deliberately preserves
// addressability for. .claude/rules/tmux-and-panes.md is updated to
// match - it previously said this path "MUST STAY" unguarded, full
// stop, and did not have this exception to make.
//
// Pre-existing, found by this lane's review rather than introduced by
// it: passing both used to silently send keys and drop text, still
// reporting sent: true. "keys won, text vanished" is not a thing any
// caller can have meant, so this is a caller error, the same way
// passing neither already is below.
```

## line 1836

```
// Issue #150. Checked before any pane read, both because it is the
// cheapest possible rejection (no tmux fork) and because a bad byte
// means send it via keys instead - not "read the pane and try
// anyway". src/tmux.ts's own comment on this detector explains why
// a control byte reaches tmux as a keystroke rather than as text.
```

## line 1860

```
// Todo 317. The sibling of the dialog check above: a modal REPLACES
// the input box, so that check needs it ABSENT and cannot see this
// case at all, while a human mid-sentence has a box very much
// PRESENT with real text in it. Which states count is
// holdsHumanInput's call (src/tmux.ts); the rest of that argument,
// and why this path had no such check for a full release, is in
// .claude/rules/tmux-and-panes.md, which fires on this file.
//
// Local to this call site, and not stated anywhere else:
//
// REFUSES rather than holds. The scheduler holds because a wake is
// a timer that retries; every typing path in this file has a
// synchronous caller standing right there, so it returns a receipt
// naming the condition and carrying the pane tail instead.
//
// SUBMIT=FALSE IS EXEMPT ON PURPOSE, and this exemption exists
// nowhere else because no other typing path has the parameter. The
// destructive event is the ENTER, not the paste: a submitted merge
// sends a human's half-written sentence as a message he never
// finished, which he cannot take back, while submit=false leaves
// characters in a box where they are visible and editable - the
// `keys` category, drive this TUI deliberately, not the
// inject-a-user-turn category this guard is for. That argument is
// the whole of it and stands on its own.
//
// IT USED TO REST ON A SECOND ARGUMENT THAT WAS FACTUALLY WRONG,
// and the correction is worth keeping because the wrong version is
// the intuitive one. It claimed that guarding submit=false would
// break compose-then-send, since the second call would refuse on
// the first call's own text. Backwards: the guard is on the
// SUBMITTING call, and the submitting call IS the second one. So
// agent_send(text:"a", submit:false) then agent_send(text:"b")
// refuses at "b" - the exact failure the wrong argument was used to
// justify avoiding. Text typed by send-keys -l carries no faint
// attribute (it is how test/fixtures/panes/real-input.txt was
// produced), so classifyInputBox correctly calls it "pending" and
// cannot tell a composing caller's own fragment from a human's.
//
// SO COMPOSE-THEN-SEND IS TWO TEXT CALLS NO LONGER. It is
// agent_send(text, submit:false), as many times as needed, then
// agent_send(keys:["Enter"]) to submit what was composed. The note
// below says so, because a caller that discovers the refusal has no
// way to work this out. Accepted rather than fixed: distinguishing
// "text this caller put there" from "text a human typed" needs
// provenance the pane does not carry, and getting it wrong in the
// permissive direction is exactly the clobber. A composing caller
// knows it is composing; a human mid-sentence does not know anyone
// is about to type over them.
//
// COST, measured on this project's own machine rather than
// estimated (tmux 3.7b, 200x50 pane, 54-row window, through the
// same execFileSync path): a capture-pane fork is 3.5ms median,
// 4.2ms p90, with plain and -e indistinguishable. It is spent only
// when submitting, which is exactly the branch that already sleeps
// ENTER_DELAY_MS (300ms) between paste and Enter, so it is ~1.2% of
// a call that path already pays for. The submit=false path, which
// has no sleep and would wear the overhead worst, skips it
// entirely. Order matters too and is deliberate: the dialog check
// runs FIRST so a modal still refuses on one fork, and reversing
// would cost two there, since a modal makes INPUT_BOX_PRESENT false
// and inputBoxState can never short-circuit a dialog.
//
// The receipt reports the box that DECIDED rather than a fresh read
// of the same pane: re-reading to fill input_box would fork twice
// and could report a box that had already changed, so a caller
// shown "pending" could not trust it as the reason for its own
// refusal.
```

## line 1935

```
// THE REMEDY BRANCHES ON WHETHER THE KEYS PATH WOULD ACTUALLY
// WORK FOR THIS CALLER, tested with the identical predicate
// that path uses a few lines above, so the two can never
// disagree: telling a worker to clear a LEAD's line sends it
// straight into that path's throw. src/scheduler.ts's
// howToClearIt makes the same branch for the same reason, on
// isLead alone, because a wake body is written before anyone
// knows who will read it; here the caller is known, so the
// condition can be the real one.
//
// It does NOT mention submit=false as a remedy, deliberately.
// That is a one-step path to arming the very clobber this
// refusal just prevented: the append lands on the human's
// half-typed line, and the next thing he does is press Enter
// on a line that starts with his own words. submit=false is
// discoverable from the schema by a caller that means to
// compose; it has no business being suggested to one that
// has just been told a human is mid-sentence.
```

## line 1963

```
// TODO 414. sendText is a paste and then, ENTER_DELAY_MS later, a
// SEPARATE tmux call for the Enter (src/tmux.ts). A throw from that
// second call used to propagate as-is - a bare TmuxError - and a
// caller reading a throw as "nothing was sent" retries the whole
// send, pasting the same text onto the end of the stranded copy and
// submitting both as one message. On a plain shell pane (no claude
// chrome for holdsHumanInput to see) that merged line EXECUTES.
//
// THE FIX IS THE ERROR TEXT, NOT A RETRY. onPasted (todo 386's own
// mechanism, src/tmux.ts) fires the instant the PASTE CALL RETURNS,
// before the Enter is ever attempted, so by the time a throw
// reaches this catch the flag says whether that call reported
// success. THAT IS NOT THE SAME CLAIM AS "the pane holds the text"
// (fix round 1, adversarial round): a tmux call that never answers
// is a THIRD outcome, not a failure (src/tmux.ts, the paragraph
// above sendText - "A TIMED-OUT PASTE THE SERVER ALREADY EXECUTED
// LEAVES HIVE'S OWN TEXT IN THE BOX"). execFileSync's timeout kills
// the CLIENT, not a command the server already ran, so a
// TmuxTimeoutError on the paste call can throw before onPasted ever
// runs even though the text landed. `pasted === false` therefore
// only proves nothing happened when the paste call failed for a
// reason OTHER than a timeout; a timed-out paste gets its own,
// honestly-hedged message below instead of either extreme.
//
// Deliberately a throw, not a returned `sent: false` receipt, to
// match every other real tmux failure on this path (a TmuxError or
// TmuxTimeoutError already throws here) rather than the proactive
// REFUSALS above (dialog, pending box), which decide not to send
// before ever touching tmux and so have something normal to report.
// This is a failure mid-send; the receipt shape for a failure on
// this path has always been a throw. A returned `{pasted: true,
// submitted: false}` receipt was considered on the adversarial
// round (the tool already KNOWS a write occurred, so why make the
// caller parse prose to learn it) and rejected: the send genuinely
// failed, and folding that into a success-shaped receipt invites a
// caller polling only `sent` (as most of this file's own tests do)
// to read a botched delivery as fine - the exact lie slim receipts
// exist to avoid (.claude/rules/tool-contract.md). MCP's own
// isError is already the machine-checkable "this failed" signal;
// what it does not carry is WHICH failure, so the thrown message
// below opens with a stable, bracketed, never-reworded tag
// (`[agent_send:paste-landed-enter-failed]`) a future caller can
// branch on without parsing the English that follows it - the
// concrete ask from the adversarial round's finding 6, layered
// onto the throw rather than replacing it.
```

## line 2015

```
// Ambiguous, not the honest negative: the paste call itself
// timed out, so this process never learned whether it landed.
// Read as "nothing was sent" it repeats the exact lie this
// lane exists to close, one call earlier.
```

## line 2027

```
// JSON.stringify, not a bare template literal: normalizeAgentName
// (above, near line 604) blocks control characters and nothing
// else, so a name carrying a double quote is valid and a naive
// `"${agent.name}"` splice would emit
// `agent_send(name: "ba"tch", ...)` - a call that does not
// parse, making the only advertised recovery unusable.
// "was on the target's screen ... though a concurrent send could
// have changed the screen since" rather than "IS on screen right
// now" (adversarial-round finding 5): the confident claim is
// only true at the moment the paste returned. This process has
// no way to know whether a DIFFERENT concurrent send has since
// submitted or altered that same box, so the message should say
// what it actually knows - the paste landed - not assert the
// live state of a screen it has not re-read.
// THE REMEDY BRANCHES ON WHETHER THE CALLER CAN ACTUALLY REACH
// IT, tested with the identical predicate the keys-path refusal
// and the pending-box refusal above both use (todo 169), so this
// can never recommend a call that path would itself refuse.
// BLOCKING, found on the adversarial round: this message used to
// always name agent_send(keys:["Enter"]), which the keys-path
// guard a few lines above REFUSES for a worker calling it
// against the lead - exactly the human's-pane scenario todo 414
// was filed about. A refused remedy reads as an instruction the
// caller can follow and is not; that is worse than naming none.
```

## line 2066

```
// Issue #40. capturePane runs AFTER the send already landed, so a
// pane that dies during the wait must not turn a successful send
// into a reported error: a caller reading "error" here reasonably
// retries, and a duplicated instruction mid-task is worse than a
// missing tail. Same shape as paneChoiceCheck's wrapped read.
// tail and note are mutually exclusive, so one field carries either.
```

## line 2085

```
// inputBoxField wraps its own read the same way, so it is called
// unconditionally here rather than inside the try: a capturePane
// failure must not also cost the input-box read that follows it.
```

## line 2091

```
// The resolved name, not the one the caller typed: a partial name that
// found the wrong worker is invisible otherwise.
```

## line 2105

```
// 1-200, the range this tool's description already states ("default 50
// lines, max 200"). A negative reached `tmux capture-pane -S "--5"`,
// which tmux rejects as an unknown option, so the schema was calling
// valid an input the tool could never serve. See src/tools/params.ts.
```

## line 2153

```
// Issue #27's L4 fix round R10, todo 181 item 1 (BOTH SEATS). R9's
// retirement path (below) was written on the premise that closing a
// lead is "the deliberate human action that replaces the
// unanswerable question" (.claude/rules/tmux-and-panes.md's own
// words) - but nothing enforced that premise. Any WORKER could call
// agent_close(name: "lead") same as a human at a terminal; a worker
// on a different tmux server even got a false "dead" for a lead
// that is genuinely still running elsewhere, and retired it. Checked
// before the probe below, and before the live-lead refusal further
// down, because a worker has no business here whether the target
// reads live, dead, or unknown: a plain claude session is
// user:<name> and a peer lead is lead:N (src/context.ts), so only a
// spawned worker's HIVE_AGENT_ID-derived agent:<id> trips this.
```

## line 2173

```
// ISSUE #156: CLOSING A PARKED LANE IS HOW A PARK IS ABANDONED, and
// without this there is no way to abandon one at all. A parked row is
// already closed, so nothing here has a pane to kill; what it has is a
// stamp that `hive status` reports and a next-morning lead plans
// around. Leaving that stamp on a lane nobody will resume is precisely
// the "a parked crew that exists only on the board goes stale" failure
// this feature was built to end, reached from inside the feature.
//
// It is the Remove-after-Retire flow .claude/rules/tool-contract.md's
// matrix already describes for pads (pad_archive, then pad_delete),
// not a second meaning for agent_close: the row ends up exactly where
// an ordinary close leaves one, plain closed.
//
// Reachable only by agent_id, and that is findAgent's shape rather
// than a restriction chosen here - its name branch resolves among
// RUNNING rows and reports a closed match as an error. Fine for this
// case: `hive status` prints the agent_id beside every parked lane, so
// the caller reading the stale entry already has the one thing this
// needs.
```

## line 2193

```
// Conditional, and it throws on a loss for the same reason the
// ordinary close below does: a concurrent agent_resume can flip this
// row running and clear the stamp between findAgent and this write,
// and an unconditional release would then report `closed: true` over
// a live worker with a live pane (counselors, all three seats).
// ONE TRANSACTION, because the gap between these two writes is a
// real window rather than a theoretical one: a scheduler ticks every
// three seconds in EVERY hive session on the machine, so a tick
// landing between the release and the ledger write files exactly the
// obituary the ledger write exists to prevent. The two statements
// are one fact - "this lane was deliberately abandoned" - so they
// commit together or not at all.
//
// A plain db.transaction is safe here: this handler never calls
// withWindowClaim, which is the one transaction in this codebase
// that must be outermost on its call stack
// (.claude/rules/store-and-datadir.md).
```

## line 2222

```
// ABANDONING A PARK IS A DECISION, NOT A DEATH, AND THE SCHEDULER
// WAS TOLD SO in the transaction above. Do not delete that
// markGoneReported call without reading its own comment
// (src/scheduler.ts).
//
// The park exclusion in standingGoneRows is `parked_at = ''`, a
// FILTER rather than a claim: while the lane sits parked, no cursor
// row is ever written for it. The release above clears parked_at and
// deliberately touches nothing else - not closed_at, not
// agent_state - so without this line the very next scheduler tick
// sees a closed row, still 'working', no longer parked, with an
// episode nothing has reported, and tells the lead that worker DIED
// and to go and excavate its branch. Last night's timestamp, at
// 09:00, about a lane the lead just deliberately abandoned.
//
// A fourth filter would not close it - the release is exactly the
// moment a filter's condition stops holding. The ledger is durable:
// it records that this episode has been dealt with, which is what a
// deliberate release means, and it survives any later change to the
// columns standingGoneRows reads.
```

## line 2244

```
// Refuse rather than half-close, for every kind. Closing the row
// while the pane may still be up leaks a running process nothing
// tracks, and the kill would not land anyway while tmux is
// unreachable - unknown liveness must never be treated as dead
// (issue #14).
```

## line 2251

```
// Issue #27's L4 fix round R9, todo 176 item 2. Used to refuse ANY
// lead target outright, unconditionally - the argument (nothing
// supervises the lead, so ending its session is a decision only its
// own terminal gets to make) still holds while the pane is LIVE, and
// still refuses here for exactly that reason. But an unconditional
// refusal also meant a lead row could never be retired: the janitor
// exempts kind='lead' (DECISION 3) and startYmlCommand cannot reach
// it, so a lead whose session had genuinely ended stayed
// status='running' forever, which is what made `hive restore`
// latch shut permanently (todo 165) and then, after R8's liveness
// probing attempt, guess wrong in both directions (todo 176's own
// finding). A lead whose pane is CONFIRMED dead - not merely
// unprobed - can now be closed like anything else, which is the
// deliberate human action that replaces the unanswerable question.
```

## line 2278

```
// Issue #27's L4 fix round R10, todo 181 item 3 (codex F1).
// Conditional on the target this call actually probed as `live`
// above, not merely on id and status='running': a concurrent `hive
// lead` can record a fresh pane on this exact row between the probe
// and this write (the row this call read as a confirmed-dead lead,
// CAS'd back to running by a restart that landed in the gap), and an
// unconditional close would retire it anyway on the strength of a
// probe that is no longer true - the lead keeps running but stops
// resolving by name, and a peer store's `hive restore` loses this
// row as a live-usage signal too. No kill-pane can have hit the
// WRONG pane from this race (the branch above only kills when this
// call's own probe said live, and a lead never reaches it live -
// see the refusal above), so the only thing this guards is the row
// write itself.
```

## line 2293

```
// Todo 369, measured live tearing down issue #156's own lane. This
// call may have just killed a live pane above (`if (live)
// killAgentPane(...)`), and that cannot be undone by a lost CAS -
// the old message here claimed "Nothing was closed" over exactly
// that case, which is false: the pane this call killed stayed
// killed. Re-read the row (classifyLostCas's own comment) rather
// than assume, and name the janitor as the plausible winner when
// this call's own kill is what gave it something to reap - the old
// message named only a concurrent `hive lead`, which is real for a
// dead-lead retirement race but was never the cause of the case
// that was actually measured.
```

## line 2307

```
// Counselors (all three seats), fix round on this same commit.
// `live` alone conflates two different facts: isLive(agent)
// (above) returns false WITHOUT EVER PROBING TMUX whenever
// agent.status !== "running" - so a row that was ALREADY closed
// when this call read it produces live===false with no tmux
// check behind it at all, same as a row this call genuinely
// probed and found dead. The old wording claimed "this call
// found the pane already dead" for BOTH, which is false for the
// first: test/agent-close-honest-cas.test.mjs's own fixture
// pre-closes the row via SQL and never touches the real pane,
// which stays genuinely alive - proving the claim wrong against
// this lane's own test data.
```
