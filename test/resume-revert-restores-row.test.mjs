import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UPSERT_ACTOR_SQL_PREFIX,
  clearHiveEnv,
  isolateTmux,
  namedInStandingReport,
  scratchDirs,
  seedDeadPaneLead,
  seedStandingWatch,
} from "./helpers.mjs";

const { hasTmux } = isolateTmux("the resume-revert restore tests");
clearHiveEnv();

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;

const { db, migrate } = await import("../dist/db.js");
migrate();
const { addProject } = await import("../dist/context.js");
const { RESUME_FLIP_COLUMNS, parkAgentRow, resumeAgent, resumeFlipSql } = await import("../dist/spawn.js");
const { seedGoneCursor, tick } = await import("../dist/scheduler.js");

const project = addProject(dirs.projectDir, "rr");
const OWNER = "lead:rr";
seedDeadPaneLead(db, project.id, dirs.projectDir, OWNER);

const SNAPSHOT = { panes: new Set(), windows: new Set() };

const SEEDED = {
  status: "closed",
  closed_at: "2026-08-11 18:00:00",
  tmux_target: "%77",
  pane_pid: "4242",
  agent_state: "working",
  state_changed_at: "2026-08-11 17:59:00",
  parked_at: "2026-08-11 18:00:00",
  parked_branch: "todo-374-park-restore",
  resumed_at: "",
  tmux_socket: "/tmp/rr-socket/default",
  command: "claude --name rr",
};

let seq = 0;
function closedWorker(over = {}) {
  const row = { ...SEEDED, ...over };
  const name = `rr-${(seq += 1)}`;
  const id = db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, cwd, kind, session_id, created_at,
          status, closed_at, tmux_target, pane_pid, agent_state, state_changed_at,
          parked_at, parked_branch, resumed_at, tmux_socket, command)
        VALUES (?, ?, ?, ?, 'agent', 'fake-session-id', datetime('now', '-300 seconds'),
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      project.id,
      `agent:${name}`,
      name,
      dirs.projectDir,
      row.status,
      row.closed_at,
      row.tmux_target,
      row.pane_pid,
      row.agent_state,
      row.state_changed_at,
      row.parked_at,
      row.parked_branch,
      row.resumed_at,
      row.tmux_socket,
      row.command,
    ).id;
  return { id, name };
}

function failedResume(agentId, name, duringFailure = () => {}) {
  const originalPrepare = db.prepare.bind(db);
  let threw = null;
  db.prepare = (sql) => {
    if (sql.startsWith(UPSERT_ACTOR_SQL_PREFIX)) {
      return {
        run: () => {
          duringFailure();
          throw new Error("SQLITE_BUSY: simulated pre-pane failure (todo 374)");
        },
      };
    }
    return originalPrepare(sql);
  };
  try {
    resumeAgent({
      agentId,
      actorId: `agent:${name}`,
      name,
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      cwd: dirs.projectDir,
      commandString: "claude --resume fake-session-id",
      placement: "window",
      parentActor: "test:rr",
    });
  } catch (e) {
    threw = String(e?.message);
  } finally {
    db.prepare = originalPrepare;
  }
  assert.match(
    threw ?? "",
    /SQLITE_BUSY/,
    "the injected failure never fired, so nothing was tested - check upsertActor's SQL literal",
  );
}

const rowNow = (id, columns) => db.prepare(`SELECT ${columns.join(", ")} FROM agents WHERE id = ?`).get(id);

describe(
  "a resume that fails before its pane comes up restores the row it flipped",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("puts back every column the flip wrote, not just status and closed_at", () => {
      const { id, name } = closedWorker();
      const before = rowNow(id, RESUME_FLIP_COLUMNS);

      failedResume(id, name);

      const after = rowNow(id, RESUME_FLIP_COLUMNS);

      assert.equal(after.status, "closed", "a failed resume must not strand the row running");
      assert.equal(after.parked_at, SEEDED.parked_at, "the park stamp is what makes the lane findable");
      assert.equal(after.parked_branch, SEEDED.parked_branch, "parked_branch is what rebuilds a removed worktree");
      assert.equal(after.closed_at, SEEDED.closed_at, "a fresh closed_at invents a death that never happened");
      assert.equal(after.agent_state, SEEDED.agent_state, "agent_state decides standingGoneRows' idle exclusion");
      assert.equal(after.resumed_at, "", "the resume did not happen, so the latch it stamps must not survive");
      assert.deepEqual(after, before, "the revert is the flip's exact inverse: no column left changed");

    });

    it("does not let a standing watch file an obituary for the parked lane it failed to pick up", async () => {
      const { id, name } = closedWorker();
      const watchId = seedStandingWatch(db, project.id, OWNER);

      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "control: a parked lane is not a death, so the watch must be silent about it",
      );

      failedResume(id, name);
      await tick(SNAPSHOT);

      assert.equal(rowNow(id, ["parked_at"]).parked_at, SEEDED.parked_at, "the park stamp is what the exclusion reads");
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "a failed resume must not turn a parked lane into a death notice telling the lead to excavate its branch",
      );

      db.prepare("UPDATE agents SET parked_at = '', parked_branch = '' WHERE id = ?").run(id);
      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        true,
        "positive control: with the park stamp gone this watch reports the row, so the silences above are real",
      );
    });

    it("does not let a standing watch file an obituary for an ordinary row that closed from idle", async () => {

      const { id, name } = closedWorker({ agent_state: "idle", parked_at: "", parked_branch: "" });
      const watchId = seedStandingWatch(db, project.id, OWNER);

      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "control: a close from idle was already reported, so this watch is silent about it",
      );

      failedResume(id, name);
      await tick(SNAPSHOT);

      assert.equal(rowNow(id, ["agent_state"]).agent_state, "idle", "the idle exclusion is what keeps it out");
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "a failed resume must not re-report a finish this watch had already accounted for",
      );

      db.prepare("UPDATE agents SET agent_state = 'working' WHERE id = ?").run(id);
      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        true,
        "positive control: with the idle exclusion gone this watch reports the row",
      );
    });

    it("stays silent for a watch created the supported way, whose own gone-cursor is seeded", async () => {

      const { id, name } = closedWorker({ agent_state: "working", parked_at: "", parked_branch: "" });
      const watchId = seedStandingWatch(db, project.id, OWNER);
      seedGoneCursor(watchId, project.id);

      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "control: the seeded cursor is what suppresses this row, since no other exclusion applies to it",
      );

      failedResume(id, name);
      await tick(SNAPSHOT);
      assert.equal(rowNow(id, ["closed_at"]).closed_at, SEEDED.closed_at, "the episode key must survive the revert");
      assert.equal(
        namedInStandingReport(db, watchId, name),
        false,
        "a failed resume must not re-open a death this watch had already accounted for",
      );

      db.prepare("UPDATE agents SET closed_at = datetime('now') WHERE id = ?").run(id);
      await tick(SNAPSHOT);
      assert.equal(
        namedInStandingReport(db, watchId, name),
        true,
        "positive control: a fresh closed_at defeats the seeded cursor, which is why closed_at is in the restore list",
      );
    });

    it("leaves the row alone when a concurrent park took it mid-resume", () => {

      const { id, name } = closedWorker({ parked_at: "", parked_branch: "" });

      let parkedAt;
      failedResume(id, name, () => {
        parkedAt = parkAgentRow(id, "", "branch-from-the-concurrent-park");
      });

      assert.ok(parkedAt, "the staged park must actually have won its CAS, or this tests nothing");
      const after = rowNow(id, ["status", "parked_at", "parked_branch"]);
      assert.equal(after.status, "closed");
      assert.equal(after.parked_at, parkedAt, "the concurrent park's stamp must survive the revert");
      assert.equal(
        after.parked_branch,
        "branch-from-the-concurrent-park",
        "the revert must not overwrite a park a lead just performed and got a receipt for",
      );
    });

    it("restores exactly the columns the flip writes, read off the flip statement itself", () => {

      const setClause = resumeFlipSql().replace(/^UPDATE agents SET /, "").replace(/ WHERE .*$/, "");
      const written = setClause.split(",").map((assignment) => assignment.trim().split(/\s*=/)[0]);

      assert.ok(written.length > 5, `the SET clause parse produced ${written.length} columns - the format changed`);
      assert.deepEqual(
        [...written].sort(),
        [...RESUME_FLIP_COLUMNS].sort(),
        "every column resumeAgent's flip writes must be one the revert restores",
      );
    });
  },
);
