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

const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";

function worker(name, resumedAgo, { socket = "", command = "claude" } = {}) {

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

    reset();
    worker("elsewhere", 90 * 60, { socket: FOREIGN_SOCKET });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(
      stdout,
      /worker elsewhere: has had its first-prompt latch set/,
      `a row on a socket this process cannot probe must not be reported here; got: ${stdout}`,
    );

    assert.match(stdout, /info {2}first assignment: 0 worker\(s\) awaiting one/);

    assert.match(stdout, /warn {2}agent elsewhere: recorded on tmux socket/);
  });

  it("says nothing about a worker that has no state channel to be silent through", async () => {

    reset();
    worker("build", 90 * 60, { command: "bash" });

    const { stdout } = await runCli(["doctor"], opts);

    assert.doesNotMatch(
      stdout,
      /worker build: has had its first-prompt latch set/,
      `a worker with no state channel cannot be reported as latched; got: ${stdout}`,
    );

    assert.match(stdout, /info {2}first assignment: 0 worker\(s\) awaiting one/);
  });

  it("is information, never a gate: --strict does not promote it", async () => {

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
      "--strict must not promote this warn: only a gatingWarn may change the exit code",
    );
  });
});
