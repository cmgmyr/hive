import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assertScratchStore,
  clearHiveEnv,
  isolateTmux,
  promotedCount,
  runCli,
  scratchDirs,
  warningCount,
} from "./helpers.mjs";

// TODO 377. After todo 373, `agents.resumed_at` means "started (spawned or
// resumed) and not yet given anything", and every reader that would say "this
// worker is idle, act on it" suppresses while it is set. src/hook.ts clears it
// on the first prompt that is not hive's own spawn announcement - so EVERY way
// that clearer fails to run produces one signature, and the signature is
// SILENCE: a running worker whose finishes are suppressed indefinitely, while
// the lead waits for a finish that will never be reported.
//
// `hive doctor` now names such a worker. This file pins the three things that
// decide whether the check is worth having:
//   1. IT FIRES, by name and with the duration, past the bound. The headline
//      claims only what hive OBSERVED - the latch has been set this long - and
//      not WHY, because the commonest route here is an assignment absorbed by
//      a busy pane, where the worker is productively working and only its
//      finishes are lost. The old headline said "awaiting its first
//      assignment", which is false for exactly that case (counselors).
//   2. IT DOES NOT FIRE ON THE ORDINARY CASE. A lead spawning a crew and
//      briefing each worker in turn leaves legitimate gaps of minutes, and a
//      warn that is usually on is one a reader learns to skip - `hive doctor
//      --strict`'s own argument, which would cost this check its whole value.
//   3. IT IS INFORMATION, NEVER A GATE. Plain warn(), so `--strict` does not
//      promote it (decisions/2026-08-07-strict-promotes-only-gating-warns.md),
//      matching reportPtyHeadroom's and reportOrphanTmuxServers' stance.
// Plus the zero case, printed rather than silent, so a healthy run cannot be
// mistaken for a check that never ran.
//
// THE MUTATIONS THESE DIE AGAINST, each run against this file rather than
// reasoned about, with the case each one actually killed:
//   - bound 30s instead of 30m (firing on the ordinary case) -> "says nothing
//     about a worker briefed within the bound".
//   - warn() -> gatingWarn() -> "is information, never a gate".
//   - dropping the `resumed_at != ''` clause -> "prints its line at zero too"
//     (the count reads 1 for a worker whose latch is cleared).
//   - returning silently when nothing is overdue -> both info-line cases.
//   - dropping the foreign-socket filter -> "says nothing about a row recorded
//     on a socket this process cannot see into"
//   - dropping the reportsAgentStateLog gate -> "says nothing about a worker
//     that has no state channel to be silent through"
const { hasTmux } = isolateTmux("the doctor unbriefed-worker tests");
clearHiveEnv();

const { dataDir, projectDir } = scratchDirs();
process.env.HIVE_DATA_DIR = dataDir;
const opts = { cwd: projectDir, env: { HIVE_DATA_DIR: dataDir, TMUX_TMPDIR: process.env.TMUX_TMPDIR } };

await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
migrate();

writeFileSync(join(projectDir, "hive.yml"), "profile: orchestration\n");
const init = await runCli(["init"], opts);
assert.equal(init.code, 0, init.stderr);

const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir).id;

// created_at is left at its default (now) deliberately: that keeps the row
// inside janitor()'s spawn-race guard, so doctor's own janitor call does not
// close the row out from under the assertion. resumed_at is the age under
// test and is an independent column.
// The same convention test/state-provenance-cli.test.mjs uses for a socket
// this process cannot see into: a path that cannot exist, so foreignSocket()
// answers true without depending on any real server.
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";

function worker(name, resumedAgo, { socket = "", command = "claude" } = {}) {
  // The timestamp is computed here and BOUND, rather than branching the SQL
  // text and the argument list on the same condition: one statement, four
  // positional arguments, nothing to keep in sync. `datetime('now')` writes
  // exactly this format, in UTC (src/stateProvenance.ts's parseStoreTimestamp
  // is the reader that depends on it).
  const resumedAt =
    resumedAgo === null ? "" : new Date(Date.now() - resumedAgo * 1000).toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind, resumed_at)
     VALUES (?, ?, ?, '%9600', ?, ?, '/tmp/worker', 'running', 'agent', ?)`,
  ).run(project, `agent:${name}`, name, socket, command, resumedAt);
}

const reset = () => db.exec("DELETE FROM agents;");

describe("hive doctor names a worker whose first-prompt latch never cleared", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("names the worker and how long it has been waiting", async () => {
    reset();
    worker("stranded", 47 * 60);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(
      stdout,
      /warn {2}worker stranded: has had its first-prompt latch set for 47m/,
      `the warn must name the worker and the duration; got: ${stdout}`,
    );
    assert.match(
      stdout,
      /worker stranded:[^\n]*(\n {8}[^\n]*)*suppressed every finish/,
      "it must say what the silence COSTS, not just that a column is set",
    );
  });

  it("says nothing about a worker briefed within the bound - the ordinary crew case", async () => {
    // THE CONSTRAINT THAT DECIDES THE BOUND. A lead spawns a crew and briefs
    // each worker in turn; five minutes between spawn and assignment is
    // normal, not a defect, and a check that fires here is one a reader
    // learns to skip.
    reset();
    worker("just-spawned", 5 * 60);

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(
      stdout,
      /worker just-spawned: has had its first-prompt latch set/,
      `a worker spawned five minutes ago is the ordinary case and must not warn; got: ${stdout}`,
    );
    assert.match(
      stdout,
      /info {2}first assignment: 1 worker\(s\) awaiting one, none for more than 30m/,
      "the count still has to be reported, or a healthy run reads as a check that never ran",
    );
  });

  it("prints its line at zero too, rather than going silent", async () => {
    reset();
    worker("briefed", null);

    const { stdout } = await runCli(["doctor"], opts);

    assert.match(stdout, /info {2}first assignment: 0 worker\(s\) awaiting one/);
    assert.doesNotMatch(stdout, /worker briefed: has had its first-prompt latch set/, "a cleared latch is not awaiting anything");
  });

  it("says nothing about a row recorded on a socket this process cannot see into", async () => {
    // A FOREIGN-SOCKET ROW IS NOT THIS PROCESS'S TO JUDGE, the same
    // conservatism every other per-worker read in `hive doctor` applies
    // (.claude/rules/tmux-and-panes.md). It matters more here than elsewhere
    // because such a row is stuck 'running' FOREVER by construction - the
    // janitor cannot sweep what it cannot probe - so without the filter this
    // warn fires on every run for the rest of that row's life, offering
    // pane-shaped advice this process cannot act on, right beside doctor's own
    // stuck-row warn saying the row cannot be judged from here. A warn that is
    // always on is exactly what this check's bound is chosen to avoid.
    reset();
    worker("elsewhere", 90 * 60, { socket: FOREIGN_SOCKET });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(
      stdout,
      /worker elsewhere: has had its first-prompt latch set/,
      `a row on a socket this process cannot probe must not be reported here; got: ${stdout}`,
    );
    // It must not be COUNTED either - a row this process cannot judge is not
    // one it can say is "awaiting" anything.
    assert.match(stdout, /info {2}first assignment: 0 worker\(s\) awaiting one/);
    // The control that makes the two assertions above mean something: doctor
    // did see this row, and says so in its own stuck-row report.
    assert.match(stdout, /warn {2}agent elsewhere: recorded on tmux socket/);
  });

  it("says nothing about a worker that has no state channel to be silent through", async () => {
    // COUNSELORS, TWO SEATS INDEPENDENTLY, AND IT FALSIFIED A RECORDED
    // JUSTIFICATION. agent_spawn sets kind='agent' for EVERY command, so a
    // bash or codex worker is a kind='agent' row on a LOCAL socket whose
    // resumed_at is stamped by launchAgent's INSERT and can NEVER be cleared -
    // a non-claude pane fires no UserPromptSubmit, so its hook never runs.
    // Without a state-channel gate this warn fires on every run for the life of
    // that row, and all three of its sentences are false for it: nothing was
    // suppressed (agent_state stays 'unknown' and every suppressing reader
    // gates on 'idle'), it is not waiting to be briefed, and the remedy cannot
    // work. That is verbatim the always-on-warn failure the foreign-socket case
    // above exists to prevent, one column over.
    //
    // launchAgent's own INSERT comment defended the unconditional stamp on the
    // grounds that "every reader here is gated on 'idle'"; todo 377 added the
    // reader that is not, and that comment is corrected in the same commit.
    reset();
    worker("build", 90 * 60, { command: "bash" });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(
      stdout,
      /worker build: has had its first-prompt latch set/,
      `a worker with no state channel cannot be reported as latched; got: ${stdout}`,
    );
    // Not counted either: "0 awaiting" is the honest answer about a row whose
    // latch can never mean what this check reads it to mean.
    assert.match(stdout, /info {2}first assignment: 0 worker\(s\) awaiting one/);
  });

  it("is information, never a gate: --strict does not promote it", async () => {
    // reportPtyHeadroom's and reportOrphanTmuxServers' stance, which doctor
    // already has twice.
    //
    // A DELTA ACROSS TWO RUNS, NOT AN EXIT CODE, and that is not fastidiousness
    // - the first version of this test compared exit codes and was GREEN FOR
    // THE WRONG REASON in the other direction: this suite's own environment
    // carries a pre-existing GATING warn (the dispatcher pinned to a different
    // build than the CLI under test), so `--strict` exits 1 here whatever this
    // check does. The delta isolates this warn: it must move the WARNING count
    // by exactly one and the PROMOTED count by zero.
    reset();
    const before = await runCli(["doctor", "--strict"], opts);
    worker("stranded-strict", 90 * 60);
    const after = await runCli(["doctor", "--strict"], opts);

    assert.match(after.stdout, /worker stranded-strict: has had its first-prompt latch set for 1h/);
    assert.equal(
      warningCount(after.stdout) - warningCount(before.stdout),
      1,
      "the control: this run must differ from the previous one by exactly this warn",
    );
    assert.equal(
      promotedCount(after.stdout) - promotedCount(before.stdout),
      0,
      "--strict must not promote this warn (decisions/2026-08-07-strict-promotes-only-gating-warns.md)",
    );
  });
});
