import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { UPSERT_ACTOR_SQL_PREFIX, clearHiveEnv, isolateTmux } from "./helpers.mjs";

const { hasTmux } = isolateTmux("the resumeAgent upsertActor-failure test");
clearHiveEnv();

const unitRoot = realpathSync(mkdtempSync(join(tmpdir(), "hive-resume-actor-fail-")));
process.env.HIVE_DATA_DIR = join(unitRoot, "data");
const { addProject } = await import("../dist/context.js");
const { db, migrate } = await import("../dist/db.js");
migrate();
const { resumeAgent } = await import("../dist/spawn.js");

describe(
  "resumeAgent reverts the flip when upsertActor throws",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("(gate finding, PR #161) a closed row stays closed, not stranded running with no pane", () => {
      const project = addProject(unitRoot, "resume-actor-fail");
      const agentId = db
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id)
           VALUES (?, 'agent:resume-actor-fail', 'resume-actor-fail', '%old', 'claude', ?, 'closed', 'agent', 'fake-session-id')
           RETURNING id`,
        )
        .get(project.id, project.path).id;

      const originalPrepare = db.prepare.bind(db);
      db.prepare = (sql) => {

        if (sql.startsWith(UPSERT_ACTOR_SQL_PREFIX)) {
          return {
            run: () => {
              throw new Error("SQLITE_BUSY: simulated for the gate finding on PR #161");
            },
          };
        }
        return originalPrepare(sql);
      };
      try {
        assert.throws(
          () =>
            resumeAgent({
              agentId,
              actorId: "agent:resume-actor-fail",
              name: "resume-actor-fail",
              projectId: project.id,
              projectName: project.name,
              projectPath: project.path,
              cwd: project.path,
              commandString: "claude --resume fake-session-id",
              placement: "window",
              parentActor: "test:resume-actor-fail",
            }),
          /SQLITE_BUSY/,
        );
      } finally {
        db.prepare = originalPrepare;
      }

      const row = originalPrepare("SELECT status, tmux_target FROM agents WHERE id = ?").get(agentId);
      assert.equal(row.status, "closed", "must revert the flip, not strand the row running with no pane");
    });
  },
);
