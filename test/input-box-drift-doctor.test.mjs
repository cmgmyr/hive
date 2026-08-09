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
        /info {2}input box classifier: 1 running claude worker box\(es\) probed: 1 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `a clean run must still say something, not just stay silent; got:\n${stdout}`,
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
        /info {2}input box classifier: 1 running claude worker box\(es\) probed: 0 classified cleanly, 0 classified 'unknown', 1 not classified/,
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
        /info {2}input box classifier: 1 running claude worker box\(es\) probed: 0 classified cleanly, 1 classified 'unknown', 0 not classified/,
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
