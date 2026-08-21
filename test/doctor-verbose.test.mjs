import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { assertScratchStore, clearHiveEnv, createLiveAndDialogPanes, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the doctor verbose-collapse tests");
const session = `doctor-verbose-${process.pid}`;
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

let dialogPane;
before(() => {
  if (!hasTmux) return;
  ({ dialogPane } = createLiveAndDialogPanes(session, "folder-trust-dialog.txt"));
});
after(() => cleanupTmux(session));

function worker(name, { target = "%9600" } = {}) {
  db.prepare(
    `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, command, cwd, status, kind)
     VALUES (?, ?, ?, ?, '', 'claude', '/tmp/worker', 'running', 'agent')`,
  ).run(project, `agent:${name}`, name, target);
}

const reset = () => db.exec("DELETE FROM agents;");

describe(
  "hive doctor collapses the per-worker live-state dump by default (todo 469)",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("says nothing about a worker's last log event, permission mode or pane tail without --verbose", async () => {
      reset();
      worker("quiet-one");
      worker("quiet-two");

      const { stdout } = await runCli(["doctor"], opts);

      assert.doesNotMatch(stdout, /last log event:/, `the live-state dump must not print by default; got: ${stdout}`);
      assert.doesNotMatch(stdout, /permission mode:/);
      assert.doesNotMatch(stdout, /^ {8}tail:/m);
    });

    it("prints one summary line naming the worker count and --verbose", async () => {
      reset();
      worker("quiet-one");
      worker("quiet-two");

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /info {2}worker detail: 2 worker\(s\).*--verbose/,
        `the collapsed row must say the full detail exists and how to get it; got: ${stdout}`,
      );
    });

    it("prints the same summary line at zero workers, rather than going silent", async () => {
      reset();

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(stdout, /info {2}worker detail: 0 worker\(s\).*--verbose/);
    });

    it("prints the full per-worker dump under --verbose", async () => {
      reset();
      worker("verbose-worker");

      const { stdout } = await runCli(["doctor", "--verbose"], opts);

      assert.match(stdout, /worker verbose-worker: last log event:/);
      assert.match(stdout, /permission mode:/);
      assert.match(stdout, /pane:/);
    });

    it("still prints the collapsed summary line under --verbose", async () => {
      reset();
      worker("verbose-worker");

      const { stdout } = await runCli(["doctor", "--verbose"], opts);

      assert.match(stdout, /info {2}worker detail: 1 worker\(s\).*--verbose/);
    });

    it("names a worker on a real dialog in the default summary, without printing its pane line", async () => {
      reset();
      worker("dialog-worker", { target: dialogPane });

      const { stdout } = await runCli(["doctor"], opts);

      assert.match(
        stdout,
        /info {2}worker detail: 1 worker\(s\), 1 awaiting a dialog;/,
        `the collapsed summary must still surface a real dialog, or the collapse hides the one thing it must not; got: ${stdout}`,
      );
      assert.doesNotMatch(
        stdout,
        /pane: awaiting a choice \(dialog\)/,
        "non-vacuity: the per-worker pane line must stay verbose-only, or this test would pass even if --verbose leaked into the default run",
      );
    });

    it("rejects an unknown flag, naming both --strict and --verbose", async () => {
      const { code, stderr } = await runCli(["doctor", "--bogus"], opts);

      assert.equal(code, 1);
      assert.match(stderr, /unknown argument "--bogus"\. Flags are --strict and --verbose\./);
    });
  },
);
