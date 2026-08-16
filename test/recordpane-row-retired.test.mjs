import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clearHiveEnv, isolateTmux } from "./helpers.mjs";

const { hasTmux } = isolateTmux("the recordPane row-retired tests");
clearHiveEnv();

const unitRoot = realpathSync(mkdtempSync(join(tmpdir(), "hive-recordpane-retired-")));
process.env.HIVE_DATA_DIR = join(unitRoot, "data");
const { addProject } = await import("../dist/context.js");
const { db, migrate } = await import("../dist/db.js");
migrate();
const { resumeAgent } = await import("../dist/spawn.js");
const { targetLive } = await import("../dist/tmux.js");

describe(
  "recordPane refuses a row retired while its pane was being created",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("a park landing mid-resume leaves the row parked and NO pane running", () => {
      const project = addProject(unitRoot, "recordpane-retired");
      const agentId = db
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, status, kind, session_id)
           VALUES (?, 'agent:recordpane-retired', 'recordpane-retired', '%old', 'claude', ?, 'closed', 'agent',
             'fake-session-id')
           RETURNING id`,
        )
        .get(project.id, project.path).id;

      const originalPrepare = db.prepare.bind(db);
      let createdPane = null;
      db.prepare = (sql) => {

        if (sql.startsWith("UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ?")) {
          const real = originalPrepare(sql);
          return {
            run: (...args) => {

              createdPane = args[0];

              originalPrepare(
                "UPDATE agents SET status = 'closed', closed_at = datetime('now'), " +
                  "parked_at = datetime('now'), parked_branch = 'some-branch' WHERE id = ?",
              ).run(agentId);
              return real.run(...args);
            },
          };
        }
        return originalPrepare(sql);
      };

      let threw = null;
      try {
        resumeAgent({
          agentId,
          actorId: "agent:recordpane-retired",
          name: "recordpane-retired",
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          cwd: project.path,
          commandString: "sleep 600",
          placement: "window",
          parentActor: "test:recordpane-retired",
        });
      } catch (e) {
        threw = e;
      } finally {
        db.prepare = originalPrepare;
      }

      assert.ok(createdPane, "setup bug: the db.prepare patch never intercepted recordPane's UPDATE");

      const row = originalPrepare("SELECT status, parked_at, tmux_target, pane_pid FROM agents WHERE id = ?").get(
        agentId,
      );
      assert.equal(row.status, "closed", "the park won the row and must keep it");
      assert.ok(row.parked_at, "and its park stamp must survive");
      assert.notEqual(
        row.tmux_target,
        createdPane,
        "a retired row must NOT end up naming the pane this resume created",
      );

      assert.equal(
        targetLive(createdPane),
        false,
        "the orphaned pane must be killed, not left running for a row that disowned it",
      );

      assert.ok(threw, "and the caller is told, rather than being handed a success receipt for nothing");
      assert.match(threw.message, /retired/);
    });
  },
);
