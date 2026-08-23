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

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the input-box drift doctor tests");
const session = `hive-input-box-drift-${process.pid}`;
after(() => cleanupTmux(session));

let driftedPane;
let healthyPane;
let dialogPane;
let codexHealthyPane;
let codexUnclassifiedPane;
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
  codexHealthyPane = execFileSync(
    "tmux",
    [
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",
      `cat '${join(REPO, "test", "fixtures", "panes", "codex-idle-ghost.txt")}'; sleep 600`,
    ],
    { encoding: "utf8" },
  ).trim();
  // codexInputBoxState never returns "unknown" - findCodexPromptBox is binary, either a full box or
  // null (todo 524) - so a codex worker on a dialog counts as NOT CLASSIFIED, never as drifted. This
  // pane exercises exactly that: it must land in inputBoxUnclassified, not inputBoxDrifted.
  codexUnclassifiedPane = execFileSync(
    "tmux",
    [
      "new-window",
      "-t",
      `=${session}`,
      "-P",
      "-F",
      "#{pane_id}",
      `cat '${join(REPO, "test", "fixtures", "panes", "codex-directory-trust-dialog.txt")}'; sleep 600`,
    ],
    { encoding: "utf8" },
  ).trim();
  const rendered = (target, marker) =>
    until(() => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString().includes(marker));
  await Promise.all([
    rendered(dialogPane, "trust this folder"),
    rendered(driftedPane, "for agents"),
    rendered(healthyPane, "for agents"),
    rendered(codexHealthyPane, "Summarize recent commits"),
    rendered(codexUnclassifiedPane, "Press enter to continue"),
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

function agentRow({ name, target, socket = ownSocket, command = "claude" }) {
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind, agent_state)
     VALUES (?, ?, ?, ?, ?, ?, '/tmp/worker', 'running', 'agent', 'working')`,
  ).run(project, `agent:${name}`, name, target, socket, command);
}

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

      assert.doesNotMatch(
        stdout,
        /worker worker-drifted:[\s\S]*?(for every pane on this machine|not a busy or unreadable pane)/,
        "a single worker's warn must not claim a machine-wide fact or a cause it cannot know",
      );

      assert.match(
        stdout,
        /warn {2}input box classifier: every probed input box in this project classified 'unknown'/,
        `1 of 1 probed is the all-unknown case and should say so; got:\n${stdout}`,
      );
    });

    it("reports the ratio as pane-specific, not project-wide, when only some probed boxes are unknown", async () => {

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
        /info {2}input box classifier: 1 running box\(es\) probed \(workers only - no lead pane was probeable\): 1 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `a clean run must still say something, not just stay silent; got:\n${stdout}`,
      );
    });

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

      assert.match(
        stdout,
        /lead lead:[\s\S]*?the pane a human types into/,
        "the lead's warn must name the stake that makes it different from a worker's",
      );
      assert.match(
        stdout,
        /input box classifier: 2 running box\(es\) probed \(workers plus the lead's own pane\): 1 classified cleanly, 1 classified 'unknown', 0 not classified/,
        `the lead must be inside the ratio, not reported beside it; got:\n${stdout}`,
      );
    });

    it("TODO 399: a project with a lead and no countable worker says so, and does not claim workers", async () => {
      reset();
      leadRow({ target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /input box classifier: 1 running box\(es\) probed \(the lead's own pane only - no worker pane was probeable\): 1 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `a lead-only project must not claim a worker probe it never made; got:\n${stdout}`,
      );
      assert.doesNotMatch(
        stdout,
        /workers plus the lead's own pane/,
        "no worker was probed, so the summary must not say workers were",
      );
    });

    it("TODO 399: a worker with an uncountable lead still says workers only", async () => {
      reset();
      leadRow({ target: driftedPane, socket: FOREIGN_SOCKET });
      agentRow({ name: "worker-alone", target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /input box classifier: 1 running box\(es\) probed \(workers only - no lead pane was probeable\): 1 classified cleanly/,
        `a foreign-socket lead is not a probed lead; got:\n${stdout}`,
      );
    });

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
        /input box classifier: 2 running box\(es\) probed \(workers plus the lead's own pane\): 1 classified cleanly, 1 classified 'unknown', 0 not classified/,
        `the foreign-socket lead must be skipped, not counted; got:\n${stdout}`,
      );
    });

    it("TODO 399: a lead running something other than claude is not probed at all", async () => {
      reset();
      leadRow({ target: driftedPane, command: "bash" });
      agentRow({ name: "worker-healthy-only", target: healthyPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /lead lead: input box classifies/);
      assert.match(
        stdout,
        /input box classifier: 1 running box\(es\) probed \(workers only - no lead pane was probeable\): 1 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `a non-claude lead must not enter the count in any of the three states; got:\n${stdout}`,
      );
    });

    it("a pane with no box to classify is counted as NOT CLASSIFIED, never as clean or as drifted", async () => {
      reset();
      agentRow({ name: "worker-nobox", target: dialogPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /worker-nobox:[\s\S]*?input box classifies 'unknown'/);
      assert.match(
        stdout,
        /info {2}input box classifier: 1 running box\(es\) probed \(workers only - no lead pane was probeable\): 0 classified cleanly, 0 classified 'unknown', 1 not classified/,
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
        /info {2}input box classifier: 1 running box\(es\) probed \(workers only - no lead pane was probeable\): 0 classified cleanly, 1 classified 'unknown', 0 not classified/,
        `the foreign row must not inflate the denominator; got:\n${stdout}`,
      );
    });

    it("is non-gating: --strict does not promote it, pinned against a baseline (test/CLAUDE.md #2)", async () => {

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

describe(
  "hive doctor probes a codex worker's own box, not just a claude one (todo 524)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("counts a healthy codex worker as classified cleanly, read through codex's own detector", async () => {
      reset();
      agentRow({ name: "codex-worker-healthy", target: codexHealthyPane, command: "codex" });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /info {2}input box classifier: 1 running box\(es\) probed \(workers only - no lead pane was probeable\): 1 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `a codex worker was never probed before this fix; got:\n${stdout}`,
      );
    });

    it("counts a codex worker on a dialog as NOT CLASSIFIED, never as drifted - codex has no partial box state", async () => {
      reset();
      agentRow({ name: "codex-worker-dialog", target: codexUnclassifiedPane, command: "codex" });

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(
        stdout,
        /codex-worker-dialog:[\s\S]*?input box classifies 'unknown'/,
        "findCodexPromptBox is binary (a full box, or null) - it can never emit the 'unknown' state a claude box can",
      );
      assert.match(
        stdout,
        /info {2}input box classifier: 1 running box\(es\) probed \(workers only - no lead pane was probeable\): 0 classified cleanly, 0 classified 'unknown', 1 not classified/,
      );
    });

    it("counts a mixed claude-and-codex project over both workers' own detectors", async () => {
      reset();
      agentRow({ name: "worker-claude-healthy", target: healthyPane });
      agentRow({ name: "worker-codex-healthy", target: codexHealthyPane, command: "codex" });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /info {2}input box classifier: 2 running box\(es\) probed \(workers only - no lead pane was probeable\): 2 classified cleanly, 0 classified 'unknown', 0 not classified/,
        `both harnesses' workers must land in the same count, each read by its own detector; got:\n${stdout}`,
      );
    });
  },
);
