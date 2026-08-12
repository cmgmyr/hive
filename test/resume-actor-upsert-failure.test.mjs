import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { UPSERT_ACTOR_SQL_PREFIX, clearHiveEnv, isolateTmux } from "./helpers.mjs";

// Gate finding on PR #161 (issue #154, todo 353): resumeAgent's
// upsertActor(...) call used to sit BETWEEN the flip UPDATE (which had
// already committed status='running', tmux_target='', pane_pid='') and the
// paneUp-guarded try that follows it. A throw there - SQLITE_BUSY past
// busy_timeout under contention with a concurrent withWindowClaim holder is
// the realistic case - skipped the catch entirely and stranded the row
// 'running' with no pane: the empty tmux_target the flip deliberately
// writes to dodge the janitor-race all three counselor seats found is
// EXACTLY what excludes a stranded row from ever being swept
// (janitor()'s agents sweep requires tmux_target != '').
//
// This test proves the fix (upsertActor moved inside the existing try) by
// injecting the failure directly, per the same pattern
// test/spawn-cwd-scope.test.mjs's "finding 5" uses for launchAgent's
// identical class of late failure: monkey-patch db.prepare to intercept
// upsertActor's own SQL and throw, then assert the ROW, not just that the
// call throws. Asserting only "resumeAgent throws" would pass on both the
// old and the fixed code and prove nothing - the deciding fact is whether
// the row reverts to 'closed' afterward.
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
        // upsertActor's own SQL (src/spawn.ts). The literal has to track
        // that statement, or the patch silently stops matching and
        // resumeAgent just succeeds against a real tmux fork - so it is
        // shared with the other file that patches it rather than typed here
        // (test/helpers.mjs, UPSERT_ACTOR_SQL_PREFIX).
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
