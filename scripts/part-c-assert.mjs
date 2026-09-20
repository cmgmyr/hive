function parseUtcSeconds(sqliteTimestamp) {

  const epoch = Date.parse(`${sqliteTimestamp.replace(" ", "T")}Z`) / 1000;

  if (!Number.isFinite(epoch)) {
    throw new Error(`FAILS: malformed timestamp "${sqliteTimestamp}" could not be parsed as a UTC datetime.`);
  }
  return epoch;
}

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

export function assertWakeFiredAfterLastCompletion(result) {
  const lastCompletionEpoch = requireThreeCompletions(result);
  const last = result.samples?.at(-1);
  const firedAt = last?.firedAt;
  if (firedAt == null) {

    if (last?.cancelledAt != null) {
      throw new Error(
        `PROVES NOTHING: the wake was cancelled at ${last.cancelledAt}, not fired -- the janitor likely found the ` +
          "delivery pane gone. There is no fired_at timestamp to compare against the last completion.",
      );
    }
    throw new Error(
      "PROVES NOTHING: wakes.fired_at is still null in the final sample -- the wake never fired (or was never observed firing), so there is no timestamp to compare against the last completion.",
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
      "PROVES NOTHING: wakes.fired_at is still null in the final sample -- the wake never fired (or was never observed firing), so there is nothing to check against max_wait_at.",
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
  const IDLE_TO_FIRE_WINDOW_SECONDS = 30;

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

const { screenAwaitingChoice } = await import(new URL("../dist/tmux.js", import.meta.url));
const isAwaitingChoiceScreen = (screen) => screenAwaitingChoice(screen);

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

const LOG_MAX_ROWS = 20_000;
const LOG_RETENTION_DAYS = 7;

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

  { name: "retention could not have evicted this run's rows", run: assertRetentionCouldNotHaveEvicted },

  { name: "a subagent was actually observed in flight", run: assertSubagentActuallyObserved },
  { name: "worker used its own branch's MCP server", run: assertWorkerUsedItsOwnMcpServer },
  { name: "wake fired after last completion", run: assertWakeFiredAfterLastCompletion },
  { name: "wake fired by idle detection, not a max-wait timeout", run: assertWakeFiredByIdleNotMaxWaitTimeout },
  { name: "wake held throughout the subagent window", run: assertWakeHeldThroughoutSubagentWindow },
  { name: "pane read coverage sufficient", run: assertPaneReadCoverageSufficient },
  { name: "wake did not deliver into a dialog", run: assertWakeDidNotDeliverIntoDialog },
  { name: "working tree unchanged", run: assertWorkingTreeUnchanged },
];

export function runAllAssertions(result) {
  return ASSERTIONS.map(({ name, run }) => {
    try {
      return { name, ok: true, proof: run(result) };
    } catch (e) {
      return { name, ok: false, error: e.message };
    }
  });
}
