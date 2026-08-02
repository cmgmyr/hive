import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { McpClient, clearHiveEnv, isolateTmux, scratchDirs, seedLeadRow } from "./helpers.mjs";

// Issue #73, todo 212 (step 3 of the lane): D7 on plan-73-tmux-socket.
//
// agent_close retires a lead row whose pane is "confirmed dead" -
// isLive(agent) === false, never null - and before this issue's lane
// "confirmed dead" resolved through the exact cross-server blind spot #68
// left as a residual: a caller talking to the wrong tmux server got a false
// `false` for a lead that is genuinely still running elsewhere, and retired
// it. Step 2 (todo 211) made isLive() consult the row's own recorded socket
// via rowLive(), so a foreign-socket lead row now answers null instead of
// false - agent_close's own `if (live === null) throw probeFailed(agent)`
// (src/tools/agents.ts) already sat above the retirement path, so the fix
// is the plumbing from step 2, not a new line here. This file is the test
// todo 212 asks for BECAUSE the plumbing must not be assumed to carry it.
const { hasTmux } = isolateTmux("the agent_close foreign-socket tests");

clearHiveEnv();
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");
migrate();

const ownSocket = tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR);
const FOREIGN_SOCKET = "/nonexistent/foreign-socket-dir/tmux-0/default";

const project = db
  .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
  .get("agent-close-foreign-test", dirs.projectDir).id;

function reset() {
  db.exec("DELETE FROM agents;");
}

// seedLeadRow's default tmux_target ('%not-a-real-pane') is a dead-looking
// pane on purpose: this process's own isolated tmux server genuinely has no
// such pane, so a matching-socket probe answers a real, definite `false`
// (not null) - the case this file's control needs to prove the retirement
// path still fires exactly as before this lane.
const agentStatus = (id) => db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status;

// A plain user session, deliberately: agent_close's worker-refusal check
// (currentActor().startsWith("agent:")) sits ABOVE the probe this file is
// about, and only a spawned worker trips it. A human at a terminal (a
// "user:" identity, the McpClient default with no HIVE_AGENT_ID) reaches the
// isLive() check this file actually tests.
async function callClose() {
  const mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  try {
    return await mcp.call("agent_close", { name: "lead" });
  } finally {
    await mcp.close();
  }
}

describe(
  "agent_close declines to retire a lead row it cannot honestly probe",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    beforeEach(reset);

    it("refuses a foreign-socket lead row with probeFailed, rather than retiring it", async () => {
      const id = seedLeadRow(db, project, dirs.projectDir, FOREIGN_SOCKET);

      await assert.rejects(callClose(), (err) => {
        assert.match(err.message, /could not be probed/);
        return true;
      });
      assert.equal(agentStatus(id), "running", "a row this process cannot honestly judge must not be retired");
    });

    it("control: still retires a genuinely dead lead row when the socket matches this process", async () => {
      const id = seedLeadRow(db, project, dirs.projectDir, ownSocket);

      const out = await callClose();

      assert.equal(out.closed, true, "the matching-socket case must still retire, exactly as before this lane");
      assert.equal(agentStatus(id), "closed");
    });
  },
);
