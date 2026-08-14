// Issue #31 part C step 4: the assertions over the rows part-c-gate.mjs
// collects. Pure functions, deliberately -- no tmux, no MCP client, no real
// worker -- so they can be pinned by fast synthetic-fixture unit tests
// (test/part-c-assert.test.mjs) instead of costing tokens on every change.
//
// THE RULE EVERY ASSERTION HERE FOLLOWS, and the reason it exists: part-c-
// gate.mjs's own first real run went green while structurally unable to see
// what it claimed to check -- the poll loop returned before the wake's
// scheduler tick had fired, so fired_at was null, and a bare `fired_at >
// lastCompletion` comparison against null is neither true nor an exception
// in JS, it is just quietly falsy, which is indistinguishable from "checked
// and found fine". So every assertion below asserts the PRESENCE of what it
// is about to compare -- fired_at is not null, there are exactly 3 completed
// files, agent_state_log is non-empty for this actor -- and throws a
// "PROVES NOTHING" error naming exactly what was missing, distinct from a
// "FAILS" error naming what was wrong, before it ever reaches the
// comparison. A caller that only reads the thrown message at 2am should not
// need the distinction explained twice.
//
// runAllAssertions() below evaluates every assertion independently, in its
// own try/catch, rather than stopping at the first throw: issue #55's own
// method correction (a mutation check that watches the FILE's pass/fail can
// have a later assertion be completely dead while an earlier one still
// fails, and short-circuiting is exactly why) applies here just as much as
// it does to the suite this pattern was first written for.

// /simplify's own review flagged this as re-deriving src/stateProvenance.ts's
// parseStoreTimestamp (same transform, that one returns milliseconds). Left
// duplicated rather than imported: parseStoreTimestamp is not exported, and
// this lane does not touch src/ for a two-line pure function. Same shape as
// LOG_MAX_ROWS/LOG_RETENTION_DAYS below -- keep in sync by hand; grep
// `parseStoreTimestamp` in src/stateProvenance.ts to check for drift.
function parseUtcSeconds(sqliteTimestamp) {
  // Every timestamp read out of the scratch store here is UTC with a space
  // separator and no zone suffix (datetime('now') and strftime(...'now') are
  // both UTC-by-default in SQLite); Date.parse needs the 'T' and 'Z' to not
  // silently reinterpret it in the calling process's own local zone.
  const epoch = Date.parse(`${sqliteTimestamp.replace(" ", "T")}Z`) / 1000;
  // Todo 141 item 10. Without this, a malformed non-null timestamp parses to
  // NaN, every `<=`/`>=`/`<`/`>` comparison against it is false, and an
  // assertion built to catch a real regression instead reads that as "not
  // violated" and PASSES on data it never actually understood.
  if (!Number.isFinite(epoch)) {
    throw new Error(`FAILS: malformed timestamp "${sqliteTimestamp}" could not be parsed as a UTC datetime.`);
  }
  return epoch;
}

// /simplify: the "are all 3 tracked" half of this was written a second time
// in assertWakeHeldThroughoutSubagentWindow's own isFullyDone filter. Shared
// here so the two cannot drift on what "done" means.
const isThreeDone = (completions) => Array.isArray(completions) && completions.length === 3 && completions.every((c) => c.done);

function requireThreeCompletions(result) {
  const completions = result.samples?.at(-1)?.completions;
  if (!Array.isArray(completions) || completions.length !== 3) {
    throw new Error(
      `PROVES NOTHING: expected exactly 3 tracked completion files, got ${JSON.stringify(completions)}.`,
    );
  }
  if (!isThreeDone(completions)) {
    throw new Error(`PROVES NOTHING: not all 3 subagents had completed by the last sample: ${JSON.stringify(completions)}.`);
  }
  return Math.max(...completions.map((c) => c.epochSeconds));
}

// Proves: no `idle` row exists in this actor's agent_state_log with a
// created_at at or before the last of the 3 subagents' completion -- i.e.
// hive never reported the worker idle while a subagent was still live. This
// is issue #24's own defect and the reason this gate exists at all.
export function assertNoIdleWhileSubagentsLive(result) {
  const log = result.agentStateLog;
  if (!Array.isArray(log) || log.length === 0) {
    throw new Error(
      "PROVES NOTHING: agent_state_log has no rows for this actor -- the hook never wrote anything, so there is no idle timestamp (or absence of one) to check.",
    );
  }
  const lastCompletionEpoch = requireThreeCompletions(result);
  const idleRows = log.filter((r) => r.state === "idle");
  if (idleRows.length === 0) {
    throw new Error(
      "PROVES NOTHING: no row in agent_state_log ever recorded state=idle for this actor -- either the run did not reach idle or idle detection never fired; there is no idle timestamp to compare against the last completion.",
    );
  }
  // log is ordered by id (see part-c-gate.mjs's own SELECT ... ORDER BY id),
  // which is insertion order, so the first idle row is the earliest chronologically.
  const earliest = idleRows[0];
  const earliestEpoch = parseUtcSeconds(earliest.created_at);
  if (earliestEpoch <= lastCompletionEpoch) {
    throw new Error(
      `FAILS: agent_state_log recorded state=idle at ${earliest.created_at}, at or before the last subagent's ` +
        `completion (epoch ${lastCompletionEpoch}). hive reported the worker idle while a subagent was still live.`,
    );
  }
  return `first idle row (${earliest.created_at}) is after the last of the 3 completions (epoch ${lastCompletionEpoch})`;
}

// Proves: timers.fired_at, once set, is after the last of the 3 subagents'
// completion timestamps -- the wake did not fire before the work it was
// meant to wait for had actually finished.
export function assertWakeFiredAfterLastCompletion(result) {
  const lastCompletionEpoch = requireThreeCompletions(result);
  const last = result.samples?.at(-1);
  const firedAt = last?.firedAt;
  if (firedAt == null) {
    // Named per todo 141 item 2: a cancelled timer (the janitor found the
    // delivery pane gone) previously fell into the same "never fired" message
    // as a timer that simply had not fired yet -- the wrong cause, in a
    // report whose whole point is naming the exact failure.
    if (last?.cancelledAt != null) {
      throw new Error(
        `PROVES NOTHING: the wake was cancelled at ${last.cancelledAt}, not fired -- the janitor likely found the ` +
          "delivery pane gone. There is no fired_at timestamp to compare against the last completion.",
      );
    }
    throw new Error(
      "PROVES NOTHING: timers.fired_at is still null in the final sample -- the wake never fired (or was never observed firing), so there is no timestamp to compare against the last completion.",
    );
  }
  const firedEpoch = parseUtcSeconds(firedAt);
  if (firedEpoch <= lastCompletionEpoch) {
    throw new Error(
      `FAILS: the wake fired at ${firedAt} (epoch ${firedEpoch}), at or before the last subagent's completion ` +
        `(epoch ${lastCompletionEpoch}). The wake did not wait for the actual last completion.`,
    );
  }
  return `fired_at (${firedAt}) is after the last of the 3 completions (epoch ${lastCompletionEpoch})`;
}

// Proves: across every sample taken WHILE at least one subagent was still
// live, fired_at read back null -- a continuous, sampled "held" window
// rather than one before/after look, which the plan's own constraint 4
// names as unable to tell "held correctly" apart from "fired, and nothing
// was watching".
export function assertWakeHeldThroughoutSubagentWindow(result) {
  const samples = result.samples;
  const MIN_SAMPLES = 5;
  if (!Array.isArray(samples) || samples.length < MIN_SAMPLES) {
    throw new Error(
      `PROVES NOTHING: only ${samples?.length ?? 0} samples were taken (need at least ${MIN_SAMPLES}) -- a single ` +
        "look, or too short a window, cannot distinguish held-correctly from fired-and-nothing-noticed.",
    );
  }
  const preCompletion = samples.filter((s) => !isThreeDone(s.completions));
  if (preCompletion.length === 0) {
    throw new Error(
      "PROVES NOTHING: every sample already showed all 3 subagents complete -- there is no pre-completion window " +
        "in this run's samples to check the wake was held through.",
    );
  }
  const firedEarly = preCompletion.find((s) => s.firedAt != null);
  if (firedEarly) {
    throw new Error(
      `FAILS: fired_at was already set (${firedEarly.firedAt}) at a sample where not all 3 subagents had ` +
        `completed yet (${JSON.stringify(firedEarly.completions)}). The wake fired early.`,
    );
  }
  return `fired_at stayed null across all ${preCompletion.length} pre-completion samples (of ${samples.length} total)`;
}

// Todo 141 item 2. FALSE GREEN this closes: WAKE_MAX_WAIT_SECONDS (280s) is
// comfortably longer than a correct run (~30-40s), so a scheduler regression
// that stops firing on genuine idle transitions still produces a fired_at
// well after the last completion -- assertWakeFiredAfterLastCompletion alone
// cannot tell that apart from a real idle fire, because both are "after the
// last completion". Two extra facts do distinguish them: maybeFireIdle's own
// contract only sets fired_at at-or-after max_wait_at on the timeout path, so
// fired_at strictly before it rules out a max-wait fire; and a genuine idle
// fire lands close in time to the idle row that triggered it, not merely
// somewhere in an up-to-280-second window.
export function assertWakeFiredByIdleNotMaxWaitTimeout(result) {
  const lastCompletionEpoch = requireThreeCompletions(result);
  const last = result.samples?.at(-1);
  const firedAt = last?.firedAt;
  if (firedAt == null) {
    if (last?.cancelledAt != null) {
      throw new Error(
        `PROVES NOTHING: the wake was cancelled at ${last.cancelledAt}, not fired -- nothing to check against max_wait_at.`,
      );
    }
    throw new Error(
      "PROVES NOTHING: timers.fired_at is still null in the final sample -- the wake never fired (or was never observed firing), so there is nothing to check against max_wait_at.",
    );
  }
  const maxWaitAt = last?.maxWaitAt;
  if (maxWaitAt == null) {
    throw new Error(
      "PROVES NOTHING: no max_wait_at was captured on this run's timer -- nothing to compare fired_at against.",
    );
  }
  const firedEpoch = parseUtcSeconds(firedAt);
  const maxWaitEpoch = parseUtcSeconds(maxWaitAt);
  if (firedEpoch >= maxWaitEpoch) {
    throw new Error(
      `FAILS: the wake fired at ${firedAt} (epoch ${firedEpoch}), at or after its own max_wait_at (${maxWaitAt}, ` +
        `epoch ${maxWaitEpoch}). That is a max-wait timeout fire, indistinguishable from a genuine idle fire by ` +
        "\"fired after the last completion\" alone -- idle detection may never have fired at all.",
    );
  }
  const idleEpochs = (result.agentStateLog ?? [])
    .filter((r) => r.state === "idle")
    .map((r) => ({ createdAt: r.created_at, epoch: parseUtcSeconds(r.created_at) }))
    .filter((r) => r.epoch >= lastCompletionEpoch);
  if (idleEpochs.length === 0) {
    throw new Error(
      "PROVES NOTHING: no idle row at or after the last completion was recorded -- nothing to compare fired_at's promptness against.",
    );
  }
  const triggeringIdle = idleEpochs[0];
  const IDLE_TO_FIRE_WINDOW_SECONDS = 30; // scheduler ticks every 3s in production; generous margin for a slow tick.
  // timers.fired_at is written by `datetime('now')` (src/scheduler.ts) --
  // WHOLE-SECOND resolution. agent_state_log.created_at is written by
  // `strftime('%Y-%m-%d %H:%M:%f', 'now')` (src/db.ts) -- MILLISECOND
  // resolution. Different precision ON PURPOSE for each column's own
  // reasons; nobody should "fix" that by touching the schema (no MIGRATIONS
  // entry belongs here) -- this is a COMPARISON bug, not a storage one.
  // Comparing the two at full precision made a wake that fires in the SAME
  // WALL SECOND as its triggering idle row -- the best possible outcome --
  // read as up to 0.999s "before" its own trigger, a false FAILS for hive
  // being fast rather than slow. Flooring the idle epoch to whole seconds
  // before subtracting compares both sides at the coarser of the two
  // resolutions, which is the real information content available here.
  // This does not weaken the check: a fire a full second or more before the
  // FLOORED idle second is still a genuine ordering violation and still
  // fails below, since flooring only ever moves idleEpoch DOWN (toward
  // firedEpoch), never up past it.
  const flooredIdleEpoch = Math.floor(triggeringIdle.epoch);
  const delta = firedEpoch - flooredIdleEpoch;
  if (delta < 0) {
    throw new Error(
      `FAILS: fired_at (${firedAt}) is ${Math.abs(delta)}s BEFORE the first idle row at or after the last ` +
        `completion (${triggeringIdle.createdAt}, floored to whole seconds for comparison) -- a wake cannot be ` +
        "triggered by an idle row that had not happened yet.",
    );
  }
  if (delta > IDLE_TO_FIRE_WINDOW_SECONDS) {
    throw new Error(
      `FAILS: fired_at (${firedAt}) is ${delta}s after the first idle row at or after the last completion ` +
        `(${triggeringIdle.createdAt}), outside the ${IDLE_TO_FIRE_WINDOW_SECONDS}s window a genuine ` +
        "idle-triggered fire should land in -- this reads more like a coincidental fire than one caused by that idle row.",
    );
  }
  return (
    `fired_at (${firedAt}) is before max_wait_at (${maxWaitAt}) and ${delta}s after the triggering ` +
    `idle row (${triggeringIdle.createdAt}) -- a genuine idle fire, not a max-wait timeout`
  );
}

// Mirrors src/hook.ts's TERMINAL_STATUSES, not imported: this lane does not
// touch src/hook.ts, and importing it into a read-only assertion script for
// one constant would blur that line for no real gain. Keep in sync by hand;
// `grep -n TERMINAL_STATUSES src/hook.ts` to check for drift.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled", "killed", "error"]);

function payloadShowsLiveSubagent(payloadRaw) {
  try {
    const payload = JSON.parse(payloadRaw);
    const tasks = payload.background_tasks;
    if (!Array.isArray(tasks)) return false;
    return tasks.some((entry) => entry?.type === "subagent" && !TERMINAL_STATUSES.has(String(entry?.status ?? "")));
  } catch {
    return false;
  }
}

// Todo 141 item 3. FALSE GREEN this closes, found independently by both
// counselor seats: every other assertion here can pass on a run where no
// subagent ever actually ran. A worker that decides three `sleep && date`
// calls do not warrant the Agent tool -- or batches them into its own
// foreground Bash call -- writes the same three completion files and a
// single, late Stop|idle row; waitingOnSubagents() is never exercised, and
// nothing above would have noticed. This is the positive control: at least
// one `stop` row, timestamped before the last completion, must carry a
// background_tasks payload naming a real, in-flight subagent.
export function assertSubagentActuallyObserved(result) {
  const lastCompletionEpoch = requireThreeCompletions(result);
  const log = result.agentStateLog;
  if (!Array.isArray(log) || log.length === 0) {
    throw new Error(
      "PROVES NOTHING: agent_state_log has no rows for this actor -- nothing to check for a live subagent in.",
    );
  }
  if (!log.some((r) => typeof r.payload === "string")) {
    throw new Error(
      "PROVES NOTHING: no row in agent_state_log carries a payload column -- it was not selected, so there is nothing to check.",
    );
  }
  const stopRowsBeforeLastCompletion = log.filter(
    (r) => r.event === "stop" && parseUtcSeconds(r.created_at) < lastCompletionEpoch,
  );
  const withLiveSubagent = stopRowsBeforeLastCompletion.find((r) => payloadShowsLiveSubagent(r.payload));
  if (!withLiveSubagent) {
    throw new Error(
      `FAILS: no \`stop\` row before the last completion (epoch ${lastCompletionEpoch}) carried a background_tasks ` +
        "payload naming a live subagent. Either no subagent was actually launched (the worker may have done the work " +
        "itself instead of using the Agent tool) or waitingOnSubagents() never observed one in flight -- this run " +
        `never exercised the thing this gate exists to check. Checked ${stopRowsBeforeLastCompletion.length} stop row(s).`,
    );
  }
  return `stop row at ${withLiveSubagent.created_at} (before the last completion) shows a live subagent in background_tasks -- the gate's actual subject was exercised`;
}

// Todo 141 item 4, both counselor seats independently. The worker's own
// --strict-mcp-config wiring (todo 128/129) is set up and never verified:
// spawnReceipt.announced === true is equally true whether the worker loaded
// the right hive-iso server, the machine's user-scoped installed build
// alongside it, or nothing at all -- nothing in the run used to DEPEND on
// that server existing, connecting, or pointing at THIS branch's dist.
// Claude Code namespaces MCP tools by server key, so under
// --strict-mcp-config the worker can only see mcp__hive-iso__*; the
// assignment's step 0 (part-c-gate.mjs's workerAssignment) has it call a
// hive tool and write the EXACT tool name it invoked, so a run where a
// second registration also loaded (a different prefix) is caught rather than
// silently credited.
export function assertWorkerUsedItsOwnMcpServer(result) {
  const confirmed = result.mcpServerConfirmed;
  if (confirmed == null) {
    throw new Error(
      "PROVES NOTHING: no mcp-server.confirmed file was written -- the worker never completed step 0 of the assignment, or its own hive MCP server never connected.",
    );
  }
  if (!/^mcp__hive-iso__/.test(confirmed)) {
    throw new Error(
      `FAILS: the worker's confirmed tool name was "${confirmed}", not prefixed mcp__hive-iso__ -- either a ` +
        "different hive registration answered (e.g. the machine's user-scoped installed build alongside this " +
        "branch's) or --strict-mcp-config did not scope the worker the way todo 128/129 rely on.",
    );
  }
  return `worker confirmed calling ${confirmed} -- its own branch's hive-iso MCP server, not any other registration`;
}

// Mirrors src/tmux.ts's own CHOICE_DIALOG / INPUT_BOX_PRESENT / D5
// discriminator, not imported: those three are module-private (not
// exported), and this lane does not touch src/tmux.ts for a two-regex
// discriminator -- same shape as TERMINAL_STATUSES and LOG_MAX_ROWS above.
// Keep in sync by hand; `grep -n CHOICE_DIALOG src/tmux.ts` to check for
// drift, pinned by test/part-c-assert.test.mjs's own sync test. See that
// file's own comment for why the pair, not the footer alone, is the answer:
// a modal REPLACES claude's input affordance rather than sitting beside it,
// so CHOICE_DIALOG present AND INPUT_BOX_PRESENT absent is what "awaiting a
// choice" means.
//
// Todo 392 found this copy still carried the bug that lane fixed: this is
// the STEP 11 LIVE DRIVER (part-c-gate.mjs runs it against a real worker),
// so it was misclassifying an ordinary tool-permission prompt as "no
// dialog" the same way src/tmux.ts's own pair was, right up through the
// lane's own acceptance run. Synced to match; see src/tmux.ts's own D1/D2/D3
// comments for why each alternative moved, round 2's M1/M2 for why "manual
// mode on" and "Would you like to proceed" moved again, and M1's own
// completion for "permissions on" (bypassPermissions mode's footer, missed
// by "mode on" alone). No window mismatch to fix here unlike
// scripts/restart-lead.sh's copy: paneTail above (part-c-gate.mjs) reads
// through the real agent_output MCP tool, which already applies
// src/tmux.ts's own capturePane() trimming - this file never reads tmux
// directly.
const CHOICE_DIALOG = /Esc to cancel|ctrl\+g to edit in/;
const INPUT_BOX_PRESENT = /for shortcuts|shift\+tab to cycle|mode on|permissions on/;
const isAwaitingChoiceScreen = (screen) => CHOICE_DIALOG.test(screen) && !INPUT_BOX_PRESENT.test(screen);

// Todo 141 item 5, second half: paneTail is sampled every 2 seconds
// (part-c-gate.mjs's pollUntilDone) and read by NOTHING -- agent_output
// failing becomes paneTail: null silently, and a run can lose the entire
// pane half of its evidence while staying green. This is the presence check
// the comparison assertion below depends on, split out so a caller can tell
// "too many failed reads to trust the window" apart from "the window
// genuinely never saw a dialog".
const MIN_REAL_PANE_READ_FRACTION = 0.8;

export function assertPaneReadCoverageSufficient(result) {
  const samples = result.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("PROVES NOTHING: no samples were taken at all -- nothing to check pane-read coverage on.");
  }
  const realReads = samples.filter((s) => typeof s.paneTail === "string");
  const fraction = realReads.length / samples.length;
  if (fraction < MIN_REAL_PANE_READ_FRACTION) {
    throw new Error(
      `FAILS: only ${realReads.length}/${samples.length} samples (${Math.round(fraction * 100)}%) carried a real ` +
        `pane read -- agent_output failed too often (silently becoming paneTail: null) to trust the dialog-guard ` +
        `window below. Need at least ${Math.round(MIN_REAL_PANE_READ_FRACTION * 100)}%.`,
    );
  }
  return `${realReads.length}/${samples.length} samples (${Math.round(fraction * 100)}%) carried a real pane read`;
}

// Todo 141 item 5, first half, and the plan's own constraint 4: "the dialog
// guard needs a sampled window, not one look." Couples dialog state with
// fired_at across every readable sample, not a single before/after check:
// deliverable() in src/scheduler.ts holds a wake above claimOneShot whenever
// the pane is awaiting a choice, so fired_at becoming non-null in the SAME
// sample the pane shows a dialog is exactly the shape of that guard failing.
// Scenario named on the triage pad: deliverable() breaks and a wake types
// into a choice dialog instead of holding -- this is the check built to
// catch it, where paneTail's own 2-second sampling previously went entirely
// unread.
export function assertWakeDidNotDeliverIntoDialog(result) {
  const samples = result.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("PROVES NOTHING: no samples were taken at all -- nothing to couple pane state with fired_at.");
  }
  const readable = samples.filter((s) => typeof s.paneTail === "string");
  if (readable.length === 0) {
    throw new Error(
      "PROVES NOTHING: no sample carried a real pane read (see the pane-read-coverage assertion) -- nothing to check dialog state against.",
    );
  }
  const dialogSamples = readable.filter((s) => isAwaitingChoiceScreen(s.paneTail));
  const deliveredWhileDialog = dialogSamples.find((s) => s.firedAt != null);
  if (deliveredWhileDialog) {
    throw new Error(
      `FAILS: the pane showed a choice dialog at t=${deliveredWhileDialog.t} while fired_at was already set ` +
        `(${deliveredWhileDialog.firedAt}) in that same sample -- the wake delivered into a dialog instead of holding.`,
    );
  }
  if (dialogSamples.length === 0) {
    return `no choice dialog was observed in any of ${readable.length} readable pane samples -- nothing for the wake to have delivered into`;
  }
  return `${dialogSamples.length} of ${readable.length} readable pane samples showed a choice dialog, and fired_at stayed null in every one -- the wake held rather than delivering into it`;
}

// Proves: git HEAD and `git status --porcelain` are byte-identical before
// the worker started and after it finished, AND (todo 141 item 9) dist/'s
// own content checksum is unchanged too. Named in isolated-hive.mjs's own
// header: siting the worker's project root inside this trusted checkout
// (todo 129) gives it a live path back to the working tree, so this is
// detection for that trade-off, not merely trust in the prompt's scope.
//
// dist/ is gitignored, so git HEAD and status alone are blind to it -- for a
// gate whose entire premise is "the branch's dist", a worker overwriting
// dist/hook.js would leave both of the checks above reporting "unchanged"
// while the actual code under test was rewritten out from under the run.
// part-c-gate.mjs's distChecksum() closes that the same way this assertion
// already closes the trusted-cwd trade-off: detection, not prevention.
export function assertWorkingTreeUnchanged(result) {
  const { gitBefore, gitAfter, distChecksumBefore, distChecksumAfter } = result;
  if (!gitBefore || typeof gitBefore.head !== "string" || typeof gitBefore.status !== "string") {
    throw new Error("PROVES NOTHING: no git-before snapshot was captured.");
  }
  if (!gitAfter || typeof gitAfter.head !== "string" || typeof gitAfter.status !== "string") {
    throw new Error("PROVES NOTHING: no git-after snapshot was captured.");
  }
  if (gitBefore.head !== gitAfter.head) {
    throw new Error(`FAILS: HEAD moved during the run, from ${gitBefore.head} to ${gitAfter.head}.`);
  }
  if (gitBefore.status !== gitAfter.status) {
    throw new Error(
      `FAILS: the working tree changed during the run.\nBEFORE:\n${gitBefore.status}\nAFTER:\n${gitAfter.status}`,
    );
  }
  if (typeof distChecksumBefore !== "string" || typeof distChecksumAfter !== "string") {
    throw new Error(
      "PROVES NOTHING: no dist/ checksum was captured -- git status alone cannot see a change to a gitignored path.",
    );
  }
  if (distChecksumBefore !== distChecksumAfter) {
    throw new Error(
      `FAILS: dist/'s content checksum changed during the run (${distChecksumBefore.slice(0, 12)} -> ` +
        `${distChecksumAfter.slice(0, 12)}), even though git HEAD/status did not -- dist/ is gitignored and ` +
        "invisible to both.",
    );
  }
  return (
    `git HEAD (${gitBefore.head.slice(0, 12)}) and git status --porcelain are identical before and after, and ` +
    "dist/'s content checksum is unchanged too (gitignored, so this is the only check that would have caught a change there)"
  );
}

// Duplicated from src/scheduler.ts's pruneStateLog, not imported: this lane
// does not touch src/scheduler.ts, and importing the scheduler module into a
// read-only assertion script for two constants would blur that line for no
// real gain. If these drift from src/scheduler.ts's own LOG_MAX_ROWS /
// LOG_RETENTION, this assertion's whole point -- proving retention could not
// have evicted anything this run depends on -- drifts silently with them.
// Keep in sync by hand; `grep -n LOG_MAX_ROWS src/scheduler.ts` to check.
const LOG_MAX_ROWS = 20_000;
const LOG_RETENTION_DAYS = 7;

// Proves: agent_state_log's GLOBAL id span (every actor, every project
// sharing this store -- pruneStateLog's own bound is global, not per-actor)
// and the age of its oldest row are both well inside the bounds that trigger
// pruneStateLog's two deletes, AND (todo 141 item 8) that no prune actually
// ran mid-run despite that.
//
// The bounds check alone is read only from the POST-run span, which cannot
// tell "retention's bounds were never close to triggering" apart from "a
// prune already ran and erased the evidence that it happened" -- a delete
// both removes rows and shrinks the span that would otherwise reveal it, so
// a post-run-only read can look exactly as healthy either way. Comparing
// against a boundary captured at gate START (part-c-gate.mjs's
// readGlobalSpan, called right after the scratch server connects, before the
// worker does anything) closes that: this scratch store is fresh per `up`,
// so its agent_state_log is provably empty at that point, and its first-ever
// row must therefore get id 1. A post-run MIN(id) other than 1 is direct
// evidence a prune deleted at least one row from this very run, not merely a
// risk that one theoretically could have.
//
// ACCEPTED IN NARROWED FORM (todo 141 triage; opus's own honest note, kept
// here so this is never read as live protection it is not): in a per-run
// mkdtemp store, neither half of this assertion can actually FAIL today. The
// global span is always double digits of rows and minutes old, nowhere near
// LOG_MAX_ROWS or the 7-day window, and the store is always genuinely fresh,
// so the pre-run boundary is always empty and the post-run MIN(id) is always
// 1. Its real value is guarding a FUTURE change that reuses a store across
// runs, where none of that would still be true by construction.
//
// nowMs is injectable (defaults to the real clock) so a unit test can pin
// "now" instead of racing this month's Date.now() against a fixture's fixed
// historical timestamps -- the same dependency-injection shape killSocket()
// and checkSocketPathLength() already use elsewhere in this project for the
// same reason: a real clock in a fixture is not a fixture.
export function assertRetentionCouldNotHaveEvicted(result, nowMs = Date.now()) {
  const span = result.agentStateLogGlobal;
  if (!span || span.lo == null || span.hi == null || span.oldest == null) {
    throw new Error(
      "PROVES NOTHING: no global agent_state_log span was captured (or the table was empty) -- there is nothing to check retention against.",
    );
  }
  const idSpan = span.hi - span.lo;
  if (idSpan >= LOG_MAX_ROWS) {
    throw new Error(
      `FAILS: agent_state_log's global id span is ${idSpan} rows, at or over LOG_MAX_ROWS (${LOG_MAX_ROWS}). ` +
        "pruneStateLog's row-count bound could have evicted rows this run depends on.",
    );
  }
  const oldestEpoch = parseUtcSeconds(span.oldest);
  const ageSeconds = nowMs / 1000 - oldestEpoch;
  const retentionSeconds = LOG_RETENTION_DAYS * 24 * 3600;
  if (ageSeconds >= retentionSeconds) {
    throw new Error(
      `FAILS: the oldest row in agent_state_log is ${Math.round(ageSeconds / 3600)}h old, at or over the ` +
        `${LOG_RETENTION_DAYS}-day retention window. pruneStateLog's age bound could have evicted rows this run depends on.`,
    );
  }

  const preRun = result.agentStateLogPreRunSpan;
  if (!preRun) {
    throw new Error(
      "PROVES NOTHING: no pre-run agent_state_log boundary was captured -- there is nothing to check a mid-run prune against.",
    );
  }
  let midRunPruneNote = "the store was not empty at gate start, so a mid-run prune of THIS run's own rows cannot be ruled out by id alone";
  if (preRun.count === 0) {
    if (span.lo !== 1) {
      throw new Error(
        `FAILS: the scratch store's agent_state_log was empty before this run started (pre-run boundary), but the ` +
          `post-run global MIN(id) is ${span.lo}, not 1. A prune deleted at least one row this run wrote.`,
      );
    }
    midRunPruneNote = "the pre-run boundary confirms the store was empty before this run started, and the post-run MIN(id) is exactly 1 -- no prune ran mid-run";
  }

  return (
    `agent_state_log's global id span (${idSpan} rows) and oldest-row age (${Math.round(ageSeconds)}s) are both ` +
    `well inside pruneStateLog's bounds (${LOG_MAX_ROWS} rows / ${LOG_RETENTION_DAYS} days); ${midRunPruneNote} -- ` +
    "retention could not have evicted anything this run depends on"
  );
}

export const ASSERTIONS = [
  { name: "no idle while subagents live", run: assertNoIdleWhileSubagentsLive },
  // Right after the idle check, not merely alongside it: this is the
  // precondition that makes an empty or short agent_state_log above readable
  // as "correct" rather than "evicted" -- see this function's own header.
  { name: "retention could not have evicted this run's rows", run: assertRetentionCouldNotHaveEvicted },
  // The positive control (todo 141 item 3): everything below this line can
  // pass on a run where no subagent ever actually existed. Placed early so a
  // reader scanning top-to-bottom hits it before the timing checks it
  // underwrites.
  { name: "a subagent was actually observed in flight", run: assertSubagentActuallyObserved },
  { name: "worker used its own branch's MCP server", run: assertWorkerUsedItsOwnMcpServer },
  { name: "wake fired after last completion", run: assertWakeFiredAfterLastCompletion },
  { name: "wake fired by idle detection, not a max-wait timeout", run: assertWakeFiredByIdleNotMaxWaitTimeout },
  { name: "wake held throughout the subagent window", run: assertWakeHeldThroughoutSubagentWindow },
  { name: "pane read coverage sufficient", run: assertPaneReadCoverageSufficient },
  { name: "wake did not deliver into a dialog", run: assertWakeDidNotDeliverIntoDialog },
  { name: "working tree unchanged", run: assertWorkingTreeUnchanged },
];

// Every assertion runs regardless of whether an earlier one threw: see the
// header comment on why short-circuiting is the wrong shape for a report
// that needs to say WHICH check failed, not just that the run did.
export function runAllAssertions(result) {
  return ASSERTIONS.map(({ name, run }) => {
    try {
      return { name, ok: true, proof: run(result) };
    } catch (e) {
      return { name, ok: false, error: e.message };
    }
  });
}
