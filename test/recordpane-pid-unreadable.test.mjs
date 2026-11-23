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
const { createdPidOrDiscard, resumeAgent } = await import("../dist/spawn.js");
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

  it("records a resumed pane's pid from tmux's creation output even when every later pid read fails", needsTmux, () => {
    const row = parkedRow();
    writeFileSync(budgetFile, "1000");
    const { target } = resume(row);
    const recorded = db.prepare("SELECT status, tmux_target, pane_pid FROM agents WHERE id = ?").get(row.id);
    assert.equal(recorded.status, "running");
    assert.equal(recorded.tmux_target, target);
    const actual = execFileSync(realTmux, ["display-message", "-p", "-t", target, "#{pane_pid}"], { encoding: "utf8" }).trim();
    assert.match(actual, /^\d+$/);
    assert.equal(recorded.pane_pid, actual);
    assert.equal(readFileSync(budgetFile, "utf8").trim(), "1000", "the spawn path asked list-panes for the pid again");
    execFileSync(realTmux, ["kill-pane", "-t", target]);
  });

  it("discards a created pane and refuses to record it when the creation output carries no digit pid", needsTmux, () => {
    const pane = execFileSync(
      realTmux,
      ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "recordpane-nopid", "sleep 600"],
      { encoding: "utf8" },
    ).trim();
    for (const pid of ["", " ", "12a"]) {
      assert.throws(() => createdPidOrDiscard("%999999", pid), /did not report a process id for the new pane %999999 when it created it/);
    }
    assert.throws(() => createdPidOrDiscard(pane, ""), /did not report a process id for the new pane %\d+ when it created it/);
    assert.equal(targetLive(pane), false, "the pane whose pid was missing must not be left running");
    assert.equal(createdPidOrDiscard("%999999", "4242"), "4242");
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
