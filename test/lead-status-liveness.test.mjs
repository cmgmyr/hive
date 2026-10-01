import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { fakeFailingTmux, isolateTmux, paneField, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead status liveness tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");

const BYSTANDER = `lead-status-bystander-${process.pid}`;
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";
let projectId;
let pane;
let pid;

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", BYSTANDER, "sleep 600"], { stdio: "ignore" });
  pane = execFileSync("tmux", ["list-panes", "-t", `=${BYSTANDER}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  pid = paneField(pane, "#{pane_pid}");
});

after(() => cleanup(BYSTANDER));

function leadRow(target, panePid, socket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR)) {
  db.prepare("DELETE FROM agents").run();
  return db
    .prepare(
      `INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, tmux_socket, pane_pid, status)
       VALUES (?, 'lead', 'claude', '/tmp', 'lead', 'lead:1', ?, ?, ?, 'running') RETURNING id`,
    )
    .get(projectId, target, socket, panePid).id;
}

const leadLine = (stdout) => stdout.split("\n").find((line) => /^ {2}lead {3}lead /.test(line))?.replace(/^ {2}lead {3}lead +/, "");

describe("hive status labels a lead from its verified pane ownership", () => {
  const skip = !hasTmux && "tmux is not installed";

  const cases = [
    ["a matching recorded pid is running", () => leadRow(pane, pid), "running"],
    ["a pane that no longer exists is no live pane", () => leadRow("%99999", pid), "no live pane"],
    ["a reissued pane id is no live pane", () => leadRow(pane, "1"), "no live pane"],
    ["an empty recorded pid on a live pane is pane identity unknown", () => leadRow(pane, ""), "pane identity unknown"],
    ["a foreign recorded socket is pane identity unknown", () => leadRow(pane, pid, FOREIGN_SOCKET), "pane identity unknown"],
  ];
  for (const [name, seed, label] of cases) {
    it(name, { skip }, async () => {
      const id = seed();
      const before = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
      const { code, stdout } = await runCli(["status"], opts);
      assert.equal(code, 0, stdout);
      assert.equal(leadLine(stdout), label, stdout);
      assert.deepEqual(db.prepare("SELECT * FROM agents WHERE id = ?").get(id), before, "status must not change the row");
    });
  }

  it("an unanswered tmux probe is pane identity unknown, never running", { skip }, async () => {
    leadRow(pane, pid);
    const fake = fakeFailingTmux({ failOn: "list-panes" });
    const { stdout } = await runCli(["status"], { ...opts, env: { PATH: `${fake}:${process.env.PATH}` } });
    assert.equal(leadLine(stdout), "pane identity unknown", stdout);
  });
});
