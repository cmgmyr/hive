import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  REPO,
  assertScratchStore,
  clearHiveEnv,
  createLiveAndDialogPanes,
  failureCount,
  isolateTmux,
  promotedCount,
  runCli,
  scratchDirs,
  until,
} from "./helpers.mjs";

// Todo 319. Nothing told you inputBoxState()'s chrome-matching had drifted,
// and every guard resting on it (the scheduler's wake hold, agent_send's text
// refusal, agent_rename's refusal) fails SILENTLY when it does: none of the
// three carry an input_box field on the paths that clobber (a successful
// send with no wait_ms, a delivered wake, agent_rename's own receipt).
// test/input-box.test.mjs cannot catch this either, by construction - it
// replays FROZEN captures taken at one Claude Code version, so a real chrome
// change can never turn that suite red. This file pins the channel todo 319
// built instead: `hive doctor` reading a running claude worker's real pane
// and naming any box that classifies "unknown".
const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the input-box drift doctor tests");
const session = `hive-input-box-drift-${process.pid}`;
after(() => cleanupTmux(session));

// createLiveAndDialogPanes creates the session and replays one fixture into
// a pane; reused here for drifted-prompt-glyph.txt (test/input-box.test.mjs's
// own fixture for "INPUT_BOX_PRESENT matches, findInputBoxRow does not" -
// verified there to classify {state: "unknown", text: ""}) rather than
// hand-rolling the identical new-session/new-window shape a second time. The
// other two panes (ready-idle.txt, a genuinely healthy box; folder-trust-
// dialog.txt, verified in test/input-box.test.mjs to make inputBoxState
// return null - INPUT_BOX_PRESENT is absent from it entirely, standing in for
// the TOTAL-drift shape counselors found this check was blind to) are one
// more manual replay each on top, the same pattern
// test/state-provenance-cli.test.mjs's busyPane/longPane already use for a
// third and fourth pane beyond that helper's own two.
//
// Counselors F5 (opus), confirmed real: the panes must be RENDERED before any
// test reads them, or a not-yet-rendered blank pane reads `null` for a reason
// that has nothing to do with the fixture and the healthy-box control passes
// without ever proving what it claims. test/input-box.test.mjs's own B4 note
// and test/pane-fixtures.test.mjs both wait on the fixture's marker text
// before asserting; this file skipped that wait entirely until now.
let driftedPane;
let healthyPane;
let dialogPane;
before(async () => {
  if (!hasTmux) return;
  ({ dialogPane } = createLiveAndDialogPanes(session, "folder-trust-dialog.txt"));
  driftedPane = execFileSync(
    "tmux",
    [
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",
      `cat '${join(REPO, "test", "fixtures", "panes", "drifted-prompt-glyph.txt")}'; sleep 600`,
    ],
    { encoding: "utf8" },
  ).trim();
  healthyPane = execFileSync(
    "tmux",
    [
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",
      `cat '${join(REPO, "test", "fixtures", "panes", "ready-idle.txt")}'; sleep 600`,
    ],
    { encoding: "utf8" },
  ).trim();
  const rendered = (target, marker) =>
    until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes(marker));
  await Promise.all([
    rendered(dialogPane, "trust this folder"),
    rendered(driftedPane, "for agents"),
    rendered(healthyPane, "for agents"),
  ]);
});

const { dataDir, projectDir, tmp } = scratchDirs();
const opts = { cwd: projectDir, dataDir, tmp };

clearHiveEnv();
process.env.HIVE_DATA_DIR = dataDir;
await assertScratchStore();

const { db, migrate } = await import("../dist/db.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";

const init = await runCli(["init"], opts);
assert.equal(init.code, 0, init.stderr);

const project = db.prepare("SELECT id FROM projects WHERE path = ?").get(projectDir).id;

function agentRow({ name, target, socket = ownSocket }) {
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind, agent_state)
     VALUES (?, ?, ?, ?, ?, 'claude', '/tmp/worker', 'running', 'agent', 'working')`,
  ).run(project, `agent:${name}`, name, target, socket);
}

// Todo 399. The lead row this check was blind to until this lane. `kind`
// and `command` are the two columns the new probe branches on, so both are
// parameters here rather than baked in: `reportsAgentStateLog` (which gates
// the per-worker loop) requires kind='agent', so a lead can never reach that
// loop and the probe had to be its own read.
function leadRow({ name = "lead", target, socket = ownSocket, command = "claude" }) {
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind, agent_state)
     VALUES (?, ?, ?, ?, ?, ?, '/tmp/lead', 'running', 'lead', 'working')`,
  ).run(project, `lead:${name}`, name, target, socket, command);
}

function reset() {
  db.exec("DELETE FROM agent_state_log; DELETE FROM agents;");
}

describe(
  "hive doctor names a running claude worker whose input box has drifted (todo 319)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("HEADLINE: warns, by name, on a worker whose box classifies 'unknown'", async () => {
      reset();
      agentRow({ name: "worker-drifted", target: driftedPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /warn {2}worker worker-drifted: input box classifies 'unknown'/,
        `expected a named warn for the drifted worker; got:\n${stdout}`,
      );
      // Lead review on commit 1f323cf, then counselors on the same PR: the
      // per-worker warn used to claim "for every pane on this machine" from
      // ONE worker's observation, then (after the first fix) still named a
      // CAUSE it could not know ("not a busy or unreadable pane") - a boxed
      // tool output above a real dialog can produce 'unknown' with no chrome
      // change at all (INPUT_BOX_PRESENT is unanchored over 18 rows). The
      // per-worker line states only the observation now; every claim beyond
      // it belongs to the ratio.
      assert.doesNotMatch(
        stdout,
        /worker worker-drifted:[\s\S]*?(for every pane on this machine|not a busy or unreadable pane)/,
        "a single worker's warn must not claim a machine-wide fact or a cause it cannot know",
      );
      // With exactly one worker probed and one drifted, the ratio IS 100%,
      // so the all-unknown reading is earned here - this is the other half
      // of the same fix, not just the removal. "in this project", never
      // "machine-wide" (counselors: `workers` is `WHERE project_id = ?`).
      assert.match(
        stdout,
        /warn {2}input box classifier: every probed input box in this project classified 'unknown'/,
        `1 of 1 probed is the all-unknown case and should say so; got:\n${stdout}`,
      );
    });

    it("reports the ratio as pane-specific, not project-wide, when only some probed boxes are unknown", async () => {
      // The case the headline test's own ratio line cannot distinguish: with
      // only one worker probed, "1 of 1 unknown" and "unknown project-wide"
      // are the same fact. Here two are probed and only one drifts, so the
      // two readings diverge and only the pane-specific wording is honest.
      reset();
      agentRow({ name: "worker-drifted-mixed", target: driftedPane });
      agentRow({ name: "worker-healthy-mixed", target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(stdout, /warn {2}worker worker-drifted-mixed: input box classifies 'unknown'/);
      assert.match(
        stdout,
        /warn {2}input box classifier: 1 of 2 probed input boxes in this project classified 'unknown' - some but not all/,
        `expected the pane-specific ratio wording; got:\n${stdout}`,
      );
      assert.doesNotMatch(
        stdout,
        /every probed input box in this project classified 'unknown'/,
        "one drifted box out of two probed must not be reported as project-wide drift",
      );
    });

    it("control: a worker with a healthy box is not named, and the clean-run line reports all three states", async () => {
      reset();
      agentRow({ name: "worker-healthy", target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /worker-healthy:[\s\S]*?input box classifies 'unknown'/);
      assert.match(
        stdout,
        /info {2}input box classifier: 1 running claude box\(es\) probed \(workers only - no lead pane was probeable\): 1 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `a clean run must still say something, not just stay silent; got:\n${stdout}`,
      );
    });

    // TODO 399. The exclusion this check shipped with, closed. The loop
    // above is `kind = 'agent'`, so the LEAD's pane was never probed - and
    // the lead's pane is the only pane a human types into, which makes it
    // the only pane where this detector failing destroys a person's
    // half-written message rather than a wake. That is not hypothetical:
    // todo 389 is the incident, and todo 399 is its mechanism.
    //
    // RED-FIRST against the version without the lead probe: the warn does
    // not appear and the count reads 1 (the worker alone), not 2.
    it("TODO 399: warns on the LEAD's own drifted box, and counts it alongside the workers", async () => {
      reset();
      leadRow({ target: driftedPane });
      agentRow({ name: "worker-healthy-beside-lead", target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /warn {2}lead lead: input box classifies 'unknown'/,
        `expected a named warn for the lead's own pane; got:\n${stdout}`,
      );
      // The warn says WHY this pane is the one that matters, which the
      // per-worker wording deliberately does not.
      assert.match(
        stdout,
        /lead lead:[\s\S]*?the pane a human types into/,
        "the lead's warn must name the stake that makes it different from a worker's",
      );
      assert.match(
        stdout,
        /input box classifier: 2 running claude box\(es\) probed \(workers plus the lead's own pane\): 1 classified cleanly, 1 classified 'unknown', 0 not classified/,
        `the lead must be inside the ratio, not reported beside it; got:\n${stdout}`,
      );
    });

    // TODO 399, PR GATE ON THE REBASED HEAD - AND THE REASON IT SURVIVED
    // REVIEW IS THE PART WORTH KEEPING. Every seeded case in this file that
    // calls leadRow() also calls agentRow(), so the LEAD-ONLY project was not
    // exercised anywhere: a fixture corpus structurally unable to see a case,
    // the same class as the 220-column blindness this lane found in
    // test/fixtures/panes/, in a different dimension. Two instances in one
    // lane.
    //
    // The summary line used to phrase itself off the LEAD counter alone, so a
    // project with a running claude lead and no countable worker - no agent
    // rows yet, or every worker row foreign-socket or non-claude - printed
    // "workers plus the lead's own pane" having probed no worker at all. A
    // report claiming a measurement it did not take, in the surface this lane
    // exists to make trustworthy.
    //
    // RED against phrasing off `leadsProbed` alone.
    it("TODO 399: a project with a lead and no countable worker says so, and does not claim workers", async () => {
      reset();
      leadRow({ target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /input box classifier: 1 running claude box\(es\) probed \(the lead's own pane only - no worker pane was probeable\): 1 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `a lead-only project must not claim a worker probe it never made; got:\n${stdout}`,
      );
      assert.doesNotMatch(
        stdout,
        /workers plus the lead's own pane/,
        "no worker was probed, so the summary must not say workers were",
      );
    });

    // The same gap from the other side: a lead that exists but is NOT
    // countable (foreign socket here; non-claude is covered separately above)
    // alongside a real worker must still say "workers only". This is the
    // direction counselors already fixed, kept as the control that stops a
    // future edit collapsing the three cases back into two.
    it("TODO 399: a worker with an uncountable lead still says workers only", async () => {
      reset();
      leadRow({ target: driftedPane, socket: FOREIGN_SOCKET });
      agentRow({ name: "worker-alone", target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /input box classifier: 1 running claude box\(es\) probed \(workers only - no lead pane was probeable\): 1 classified cleanly/,
        `a foreign-socket lead is not a probed lead; got:\n${stdout}`,
      );
    });

    // TODO 399, COUNSELORS ROUND 1 (two seats independently). The first
    // version used `.get()` with `ORDER BY id`, so with two running lead rows
    // only the LOWEST id was probed. That state is reachable - ensureLeadRow's
    // own comment in src/cli.ts documents it - and lead rows are exempt from
    // the janitor, so a dead-but-`running` first row shadows the live lead
    // FOREVER: a standing "not classified" in the denominator and the one
    // pane a human types into never probed. Seeded here the way the defect
    // actually arrives: an older foreign-socket lead at the lower id, the
    // live drifted one above it.
    //
    // RED against `.get()`: the warn never appears, and the count reads 1
    // (the foreign row is skipped) with the "no lead pane was probeable"
    // wording rather than 2.
    it("TODO 399: a stale lower-id lead row does not shadow the live lead", async () => {
      reset();
      leadRow({ name: "lead-stale", target: driftedPane, socket: FOREIGN_SOCKET });
      leadRow({ name: "lead-live", target: driftedPane });
      agentRow({ name: "worker-healthy-two-leads", target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /warn {2}lead lead-live: input box classifies 'unknown'/,
        `the live lead must be probed even when a stale row sorts ahead of it; got:\n${stdout}`,
      );
      assert.match(
        stdout,
        /input box classifier: 2 running claude box\(es\) probed \(workers plus the lead's own pane\): 1 classified cleanly, 1 classified 'unknown', 0 not classified/,
        `the foreign-socket lead must be skipped, not counted; got:\n${stdout}`,
      );
    });

    // The gate, and it is the same one every typing path here carries:
    // inputBoxState finds its box by claude's own chrome, so probing a lead
    // running something else would count a permanent, meaningless "not
    // classified" against the ratio the project-scoped warn rests on.
    it("TODO 399: a lead running something other than claude is not probed at all", async () => {
      reset();
      leadRow({ target: driftedPane, command: "bash" });
      agentRow({ name: "worker-healthy-only", target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /lead lead: input box classifies/);
      assert.match(
        stdout,
        /input box classifier: 1 running claude box\(es\) probed \(workers only - no lead pane was probeable\): 1 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `a non-claude lead must not enter the count in any of the three states; got:\n${stdout}`,
      );
    });

    // Counselors, both seats independently, the top finding on this lane's
    // own PR: `inputBoxState` returns null for a pane with no box on screen
    // to classify AT ALL - a dialog, mid-turn, an unreadable pane, or (the
    // dangerous case) a TOTAL chrome drift where INPUT_BOX_PRESENT itself
    // stops matching. The first version counted that null in the same
    // "checked" number a real clean read incremented, so it silently
    // laundered into "classified cleanly". folder-trust-dialog.txt stands in
    // for the shape (a real, verified null read - test/input-box.test.mjs
    // pins `expect: null` for this exact fixture); it is a dialog, not a
    // chrome rewrite, but it exercises the identical code path a total drift
    // would take, which is what this line of code cannot tell apart.
    it("a pane with no box to classify is counted as NOT CLASSIFIED, never as clean or as drifted", async () => {
      reset();
      agentRow({ name: "worker-nobox", target: dialogPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /worker-nobox:[\s\S]*?input box classifies 'unknown'/);
      assert.match(
        stdout,
        /info {2}input box classifier: 1 running claude box\(es\) probed \(workers only - no lead pane was probeable\): 0 classified cleanly, 0 classified 'unknown', 1 not classified/,
        `a null read must be its own counted state, not folded into clean or unknown; got:\n${stdout}`,
      );
    });

    it("control: a foreign-socket row is never probed, and is not reported as drifted", async () => {
      reset();
      agentRow({ name: "worker-foreign", target: driftedPane, socket: FOREIGN_SOCKET });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        stdout,
        /worker-foreign:[\s\S]*?input box classifies 'unknown'/,
        "a foreign-socket row's pane id must never be probed against this process's own server",
      );
      assert.doesNotMatch(
        stdout,
        /input box classifier:/,
        "a foreign-socket-only run has nothing this check actually probed, so the classifier line must not print",
      );
    });

    it("control: mixing a drifted worker with a foreign-socket one still reports the count over only the probed worker", async () => {
      reset();
      agentRow({ name: "worker-drifted-2", target: driftedPane });
      agentRow({ name: "worker-foreign-2", target: healthyPane, socket: FOREIGN_SOCKET });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(stdout, /warn {2}worker worker-drifted-2: input box classifies 'unknown'/);
      assert.match(
        stdout,
        /info {2}input box classifier: 1 running claude box\(es\) probed \(workers only - no lead pane was probeable\): 0 classified cleanly, 1 classified 'unknown', 0 not classified/,
        `the foreign row must not inflate the denominator; got:\n${stdout}`,
      );
    });

    it("is non-gating: --strict does not promote it, pinned against a baseline (test/CLAUDE.md #2)", async () => {
      // A developer machine can carry its own gating warns unrelated to this
      // check (e.g. a dispatcher pinned to a different build than the test
      // runner's own interpreter), so comparing strict vs. plain in one run,
      // or asserting a bare exit code, saturates on those instead of proving
      // anything about THIS warn. Compare against a baseline taken on the
      // SAME machine with no drifted row present, the pattern
      // test/state-provenance-cli.test.mjs's own F4 test already uses for the
      // identical shape.
      reset();
      const baseline = await runCli(["doctor", "--strict"], opts);

      agentRow({ name: "worker-drifted-strict", target: driftedPane });
      const strict = await runCli(["doctor", "--strict"], opts);

      assert.match(
        strict.stdout,
        /warn {2}worker worker-drifted-strict: input box classifies 'unknown'/,
        `the warn must actually fire in this run, or the comparison below proves nothing; got:\n${strict.stdout}`,
      );
      assert.equal(
        promotedCount(strict.stdout),
        promotedCount(baseline.stdout),
        "a drifted-box warn must not be promoted by --strict",
      );
      assert.equal(
        failureCount(strict.stdout),
        failureCount(baseline.stdout),
        `a drifted-box warn must not become a --strict problem\nstrict:\n${strict.stdout}\nbaseline:\n${baseline.stdout}`,
      );
    });
  },
);
