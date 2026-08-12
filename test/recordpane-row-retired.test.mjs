import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clearHiveEnv, isolateTmux } from "./helpers.mjs";

// COUNSELORS, ALL THREE SEATS, ISSUE #156. THE INVARIANT UNDER TEST IS ONE
// SENTENCE: recordPane must not write a pane onto a row that is no longer
// running.
//
// HOW IT WAS REACHED. resumeAgent's flip commits status='running' with
// tmux_target='' - deliberately, to take the row out of the janitor's
// `tmux_target != ''` sweep while the resume is in flight. A concurrent
// agent_park reading that row gets `{live: false}` from targetLiveProbe('')
// (FALSE, not null, src/tmux.ts), so its "unknown liveness is never dead"
// refusal does not fire, it kills nothing, and parkAgentRow's CAS compares ''
// against '' AND MATCHES. The row goes closed+parked mid-resume, and
// recordPane then wrote the live pane onto it: a running `claude --resume`
// process on a row the janitor cannot see (its sweep is status='running'),
// listed by `hive status` as resumable, and resumable AGAIN onto a second pane
// of the same session.
//
// WHY THE FIX IS IN recordPane AND NOT IN agent_park. launchAgent has the
// identical INSERT-to-recordPane gap (an agent_close landing in it), so a guard
// written into the park path would have left that twin live while reading as a
// fix. The invariant belongs to recordPane because it is true whoever retired
// the row and for whatever reason.
//
// THIS TEST DRIVES resumeAgent DIRECTLY rather than through MCP, and patches
// db.prepare to land the retirement in the exact gap - the method
// test/resume-actor-upsert-failure.test.mjs and test/spawn-cwd-scope.test.mjs's
// "finding 5" already use for this file's other late failures. The MCP server
// runs in its own process, so a test-side db.prepare patch would never be seen
// there.
//
// IT ASSERTS THE ROW *AND* THE PANE. Asserting only "resumeAgent throws" would
// pass against BOTH versions of the code, since the pre-fix version throws
// nothing and the post-fix one throws for the right reason - and the whole
// point is what is left behind, not what was raised.
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
        // recordPane's own UPDATE. The literal has to track src/spawn.ts or
        // this patch silently stops matching and resumeAgent just succeeds -
        // which is why the assertions below are on the row and the pane rather
        // than on the throw: a patch that never fired would otherwise look
        // like a passing test.
        if (sql.startsWith("UPDATE agents SET tmux_target = ?, tmux_socket = ?, pane_pid = ?")) {
          const real = originalPrepare(sql);
          return {
            run: (...args) => {
              // args[3] is agentId; the pane this resume just built is args[0].
              createdPane = args[0];
              // THE CONCURRENT PARK, landed in the exact gap: the row is
              // retired between placeAgentPane and this write. Written the way
              // parkAgentRow writes it, so the row shape is the real one.
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

      // THE ROW. It must still read exactly as the park left it. Before the
      // fix, recordPane's unconditional UPDATE wrote the live pane onto this
      // closed row, so tmux_target named a running process on a row nothing
      // sweeps.
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

      // THE PANE. The row's view - a parked lane with nothing running - has to
      // be TRUE, not merely recorded. A pane left alive here is a `claude
      // --resume` process belonging to no row, which is the half that leaks.
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
