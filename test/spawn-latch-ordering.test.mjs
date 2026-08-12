import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { clearHiveEnv, isolateTmux } from "./helpers.mjs";

// TODO 373, COUNSELORS F4. WHERE THE STAMP LANDS IS A CLAIM NO OTHER TEST CAN
// MAKE, and the counselors' codex seat is why this file exists: every other
// case in test/spawn-false-finish.test.mjs samples agents.resumed_at AFTER
// agent_spawn has returned, and a sample cannot tell a value written by the
// row's own INSERT from one written by an UPDATE a moment later. The suite was
// green against both.
//
// WHY THE ORDER MATTERS, stated as the failure rather than the rule. The first
// version of src/spawn.ts's comment said a late stamp races the announcement's
// own UserPromptSubmit hook. That is wrong: src/hook.ts recognises the
// announcement and leaves the latch alone whenever it lands. The real exposure
// is the opposite order and it is silent. agent_spawn returns once the
// announcement is typed, the lead sends the assignment seconds later, and a
// stamp written after that point lands AFTER the clearing UPDATE has run and
// found nothing to clear. The row is then latched with work already given, and
// every finish it reports is suppressed until some later prompt - the silence
// this project calls its worst outcome, reached through the fix for a false
// report.
//
// So the property is "no window exists in which a running row is unstamped",
// and the only place to observe it is INSIDE launchAgent, at the moment the
// INSERT returns. This file wraps db.prepare to watch that statement run and
// reads the row back through the unwrapped handle, which is a runtime
// observation rather than a string match on SQL. It asserts the SQL too, but
// as the weaker half.
const { hasTmux, cleanup } = isolateTmux("the spawn latch ordering test");
const { sessionName } = await import("../dist/tmux.js");

clearHiveEnv();
const root = realpathSync(mkdtempSync(join(tmpdir(), "hive-latch-order-")));
process.env.HIVE_DATA_DIR = join(root, "data");
const { addProject } = await import("../dist/context.js");
const { db, migrate } = await import("../dist/db.js");
migrate();
const { launchAgent, closeAgentRow } = await import("../dist/spawn.js");

describe(
  "todo 373: the latch is stamped by the row's own INSERT, not by a later write",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    it("a running agents row is never observable without its latch", () => {
      const dir = mkdtempSync(join(root, "proj-"));
      const project = addProject(dir, "latch-order");

      const statements = [];
      // Read back through the ORIGINAL handle: the wrapper below is installed
      // on db.prepare, and a probe going through it would recurse and also
      // pollute the recorded statement list with this test's own reads.
      const originalPrepare = db.prepare.bind(db);
      let latchAtInsert = null;

      db.prepare = (sql) => {
        statements.push(sql);
        const stmt = originalPrepare(sql);
        // startsWith rather than a full literal, for the reason
        // test/spawn-cwd-scope.test.mjs's finding 5 learned the hard way: an
        // exact match silently stops matching the next time anyone adds a
        // column to this INSERT, and a test that no longer intercepts anything
        // passes.
        if (!sql.startsWith("INSERT INTO agents (project_id, name, command")) return stmt;
        return {
          ...stmt,
          run: (...args) => {
            const info = stmt.run(...args);
            // THE OBSERVATION. Nothing else in this process has run between
            // the INSERT and this read, so a non-empty value here can only
            // have come from the INSERT itself.
            latchAtInsert = originalPrepare("SELECT resumed_at FROM agents WHERE id = ?").get(
              Number(info.lastInsertRowid),
            ).resumed_at;
            return info;
          },
        };
      };

      let agentId;
      try {
        agentId = launchAgent({
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path,
          name: "latch-order-worker",
          kind: "agent",
          commandString: "sleep 30",
          cwd: project.path,
          env: {},
          placement: "window",
          parentActor: "test:latch-order",
        }).agentId;
      } finally {
        db.prepare = originalPrepare;
      }

      assert.ok(
        latchAtInsert,
        "the row was observable as running with an empty latch: the stamp is not in the INSERT, so an " +
          "assignment landing before the real stamp would be silently suppressed",
      );

      // The weaker, structural half, kept because it names the defect a reader
      // would otherwise have to infer from the observation above: no statement
      // in this whole call writes the column a second time. A stamp moved into
      // a follow-up UPDATE fails the observation above; this fails a stamp
      // that is written in BOTH places, which reads as correct and leaves the
      // window open in whatever order the two land.
      const laterWrites = statements.filter((sql) => /^UPDATE agents SET[\s\S]*resumed_at/.test(sql));
      assert.deepEqual(laterWrites, [], "launchAgent must not write resumed_at anywhere but its INSERT");

      closeAgentRow(agentId);
      cleanup(sessionName());
    });
  },
);
