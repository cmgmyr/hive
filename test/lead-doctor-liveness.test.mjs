import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { after, before, describe, it } from "node:test";

import { failureCount, isolateTmux, makeFakeClaude, paneField, runCli, scratchDirs, warningCount } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the lead doctor-liveness tests");

const dirs = scratchDirs();
const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

function withoutConfigSourceRows(stdout) {
  return stdout.split("\n").filter((line) => !/^\s*info\s+config /.test(line)).join("\n");
}

function assertNoLeadLiveness(stdout, message) {
  assert.doesNotMatch(withoutConfigSourceRows(stdout), /lead:/, message);
  assert.throws(
    () => assert.doesNotMatch(withoutConfigSourceRows(`${stdout}\n  warn  lead: fixture liveness warning`), /lead:/),
    assert.AssertionError,
  );
}

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

const BYSTANDER = `lead-doctor-bystander-${process.pid}`;

after(() => cleanup(session, BYSTANDER));

describe("hive doctor reports a lead row whose pane is not live", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("the no-lead-row baseline itself stays quiet about the lead", () => {

    assertNoLeadLiveness(baseline.stdout, "nothing to report without a lead row");
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

  const bystanderLead = (pid) => {
    execFileSync("tmux", ["new-session", "-d", "-s", BYSTANDER, "sleep 600"], { stdio: "ignore" });
    const pane = execFileSync("tmux", ["list-panes", "-t", `=${BYSTANDER}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
    const id = db
      .prepare(
        "INSERT INTO agents (project_id, name, command, cwd, kind, actor_id, tmux_target, pane_pid, status) VALUES (?, 'lead', 'claude', ?, 'lead', 'lead:1', ?, ?, 'running') RETURNING id",
      )
      .get(projectId, dirs.projectDir, pane, pid === "live" ? paneField(pane, "#{pane_pid}") : pid).id;
    return { id, pane };
  };
  const dropBystander = () => {
    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
    cleanup(BYSTANDER);
  };

  it("warns that a lead's pane id now belongs to a different process when its recorded pid differs", async () => {
    bystanderLead("1");
    const out = await runCli(["doctor"], opts);
    assert.match(out.stdout, /warn {2}lead: the lead's row is running but its pane id now belongs to a different process/);
    assert.match(out.stdout, /agent_close\(\{agent_id: \d+, row_only: true\}\) on it/, "plain agent_close refuses a reissued pane id");
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));
    dropBystander();
  });

  it("warns pane identity unknown, naming agent_close row_only for that row, when a live lead pane has no recorded pid", async () => {
    const { id } = bystanderLead("");
    const out = await runCli(["doctor"], opts);
    assert.match(out.stdout, new RegExp(`warn {2}lead: pane identity unknown: the lead's row \\(agents.id ${id}\\)`));
    assert.match(out.stdout, new RegExp(`agent_close\\(\\{agent_id: ${id}, row_only: true\\}\\)`));
    assert.match(out.stdout, /human or peer lead \(never a worker\)/);
    assert.equal(warningCount(out.stdout), warningCount(baseline.stdout) + 1);
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));
    assert.equal(db.prepare("SELECT status, pane_pid FROM agents WHERE id = ?").get(id).status, "running");
    dropBystander();
  });

  it("control: stays quiet about a lead whose recorded pid matches its live pane", async () => {
    bystanderLead("live");
    const out = await runCli(["doctor"], opts);
    assertNoLeadLiveness(out.stdout, "a matching-pid lead owns its pane");
    dropBystander();
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

    assertNoLeadLiveness(out.stdout, "a genuinely live lead must not be reported as dead");
    assert.equal(failureCount(out.stdout), failureCount(baseline.stdout));

    const lead = db.prepare("SELECT tmux_target FROM agents WHERE project_id = ? AND kind = 'lead'").get(projectId);
    execFileSync("tmux", ["kill-window", "-t", lead.tmux_target], { stdio: "ignore" });
  });
});
