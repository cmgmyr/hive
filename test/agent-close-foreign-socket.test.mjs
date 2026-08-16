import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { McpClient, clearHiveEnv, isolateTmux, scratchDirs, seedLeadRow } from "./helpers.mjs";

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

const agentStatus = (id) => db.prepare("SELECT status FROM agents WHERE id = ?").get(id).status;

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
