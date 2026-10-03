import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { clearHiveEnv, isolateTmux, makeFakeClaude, runCli } from "./helpers.mjs";

const { hasTmux } = isolateTmux("the record-time pane pid tests");
clearHiveEnv();

const unitRoot = realpathSync(mkdtempSync(join(tmpdir(), "hive-recordpane-pid-")));
process.env.HIVE_DATA_DIR = join(unitRoot, "data");
const { addProject } = await import("../dist/context.js");
const { db, migrate } = await import("../dist/db.js");
migrate();
const { resumeAgent } = await import("../dist/spawn.js");
const { targetLive } = await import("../dist/tmux.js");

const shimDir = mkdtempSync(join(unitRoot, "shim-"));
const budgetFile = join(shimDir, "fail-budget");
const realTmux = hasTmux ? execFileSync("which", ["tmux"], { encoding: "utf8" }).trim() : "tmux";
writeFileSync(
  join(shimDir, "tmux"),
  `#!/bin/sh
for a in "$@"; do
  if [ "$a" = '#{pane_id} #{pane_pid}' ]; then
    n=$(cat '${budgetFile}')
    if [ "$n" -gt 0 ]; then
      echo $((n - 1)) > '${budgetFile}'
      echo "tmux: operation not permitted" >&2
      exit 1
    fi
  fi
done
exec '${realTmux}' "$@"
`,
  { mode: 0o755 },
);
process.env.PATH = `${shimDir}:${process.env.PATH}`;

const project = addProject(unitRoot, "recordpane-pid");
let seq = 0;

function parkedRow() {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id)
       VALUES (?, ?, ?, '%old', 'claude', ?, 'closed', 'agent', 'fake-session-id') RETURNING id, actor_id, name`,
    )
    .get(project.id, `agent:pid-${seq}`, `pid-${seq}`, project.path);
}

function resume(row) {
  return resumeAgent({
    agentId: row.id,
    actorId: row.actor_id,
    name: row.name,
    projectId: project.id,
    projectName: project.name,
    projectPath: project.path,
    cwd: project.path,
    commandString: "sleep 600",
    placement: "window",
    parentActor: "test:recordpane-pid",
  });
}

const needsTmux = { skip: hasTmux ? false : "tmux is not installed" };

describe("a pane hive just created is never recorded with an empty pid", () => {
  beforeEach(() => writeFileSync(budgetFile, "0"));

  it("retries one failed pid read and records the pane's real pid", needsTmux, () => {
    const row = parkedRow();
    writeFileSync(budgetFile, "1");
    const { target } = resume(row);
    assert.equal(readFileSync(budgetFile, "utf8").trim(), "0", "setup bug: the shim never failed a pid read");
    const recorded = db.prepare("SELECT status, tmux_target, pane_pid FROM agents WHERE id = ?").get(row.id);
    assert.equal(recorded.status, "running");
    assert.equal(recorded.tmux_target, target);
    assert.match(recorded.pane_pid, /^\d+$/);
    execFileSync(realTmux, ["kill-pane", "-t", target]);
  });

  it("discards the pane and fails the resume when both pid reads fail, leaving the row as it was", needsTmux, () => {
    const row = parkedRow();
    writeFileSync(budgetFile, "2");
    let threw = null;
    try {
      resume(row);
    } catch (e) {
      threw = e;
    }
    assert.match(threw?.message ?? "", /did not report a process id for the new pane (%\d+) \(asked twice\)/);
    const pane = /new pane (%\d+)/.exec(threw.message)[1];
    assert.equal(targetLive(pane), false, "the pane whose pid could not be read must not be left running");
    const after = db.prepare("SELECT status, tmux_target, pane_pid FROM agents WHERE id = ?").get(row.id);
    assert.equal(after.status, "closed");
    assert.equal(after.tmux_target, "%old");
  });

  it("hive lead discards a fresh lead pane whose pid tmux will not report, recording no lead row on it", needsTmux, async () => {
    const tmp = mkdtempSync(join(unitRoot, "lead-tmp-"));
    const claudePath = makeFakeClaude(tmp)("sleep 600");
    const leadDir = realpathSync(mkdtempSync(join(unitRoot, "lead-project-")));
    mkdirSync(join(leadDir, ".git"));
    const leadProject = db.prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id").get("pid-lead", leadDir);
    writeFileSync(budgetFile, "1000");
    const result = await runCli(["lead", "--no-dashboard"], {
      cwd: leadDir,
      dataDir: process.env.HIVE_DATA_DIR,
      tmp,
      env: { PATH: `${shimDir}:${dirname(claudePath)}:${process.env.PATH}` },
    });
    assert.notEqual(result.code, 0, result.stdout);
    const output = result.stdout + result.stderr;
    assert.match(output, /did not report a process id for the new lead pane (%\d+) \(asked twice\)/);
    const pane = /new lead pane (%\d+)/.exec(output)[1];
    writeFileSync(budgetFile, "0");
    assert.equal(targetLive(pane), false, "the lead pane whose pid could not be read must not be left running");
    const rows = db.prepare("SELECT tmux_target, pane_pid FROM agents WHERE project_id = ? AND status = 'running'").all(leadProject.id);
    assert.deepEqual(rows.filter((r) => r.tmux_target === pane), []);
  });
});
