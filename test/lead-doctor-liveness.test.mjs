import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { failureCount, isolateTmux, makeFakeClaude, runCli, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead doctor-liveness tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

let projectId;
let session;
let baseline;

before(async () => {
  const init = await runCli(["init"], opts);
  assert.equal(init.code, 0, init.stderr);
  projectId = db.prepare("SELECT id FROM projects LIMIT 1").get().id;
  session = sessionName();

  baseline = await runCli(["doctor"], opts);
});

after(() => cleanup(session));

describe("hive doctor reports a lead row whose pane is not live", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("the no-lead-row baseline itself stays quiet about the lead", () => {

    assert.doesNotMatch(baseline.stdout, /lead:/, "nothing to report without a lead row");
  });

  it("warns when a running lead row's pane is not live", async () => {
    db.prepare(
      "INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, status) VALUES (?, 'lead', 'claude', ?, 'lead', 'lead:1', '%nonexistent-dead-pane', 'running')",
    ).run(projectId, dirs.projectDir);

    const out = await runCli(["doctor"], opts);
    assert.match(
      out.stdout,
      /warn {2}lead: the lead's row is running but its pane is not live/,
      "a dead-paned running lead row must be reported, not silently left alone",
    );
    assert.doesNotMatch(out.stdout, /FAIL {2}stale state/, "the janitor itself must not fail or close it");

    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));

    assert.match(
      out.stdout,
      /claude session connected to this project's hive MCP server/,
      "the remedy must say where agent_close actually lives, not just name it",
    );

    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
  });

  it("warns when a running lead row's tmux_target is EMPTY (todo 180)", async () => {

    db.prepare(
      "INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, status) VALUES (?, 'lead', 'claude', ?, 'lead', 'lead:1', '', 'running')",
    ).run(projectId, dirs.projectDir);

    const out = await runCli(["doctor"], opts);
    assert.match(
      out.stdout,
      /warn {2}lead: the lead's row is running but its pane is not live/,
      "an empty tmux_target must be reported exactly like any other dead pane",
    );
    assert.doesNotMatch(out.stdout, /FAIL {2}stale state/, "the janitor itself must not fail or close it");
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));

    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
  });

  it("stays quiet when the lead row's pane is genuinely live", async () => {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const claudePath = fakeClaude("sleep 600");
    const first = await runCli(["lead"], {
      ...opts,
      env: { PATH: `${dirname(claudePath)}:${process.env.PATH}` },
    });
    assert.equal(first.code, 0, first.stderr);

    const out = await runCli(["doctor"], opts);

    assert.doesNotMatch(out.stdout, /lead:/, "a genuinely live lead must not be reported as dead");
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));

    const lead = db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND kind = 'lead'").get(projectId);
    execFileSync("tmux", ["kill-window", "-t", lead.tmux_target], { stdio: "ignore" });
  });
});
