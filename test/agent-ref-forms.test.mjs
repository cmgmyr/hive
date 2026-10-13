import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, REPO, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("agent recipient reference forms");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");
const fakeClaude = makeFakeClaude(dirs.tmp);
const readyScreen = `cat '${join(REPO, "test", "fixtures", "panes", "ready-idle.txt")}'; sleep 600`;

let mcp;
let projectId;
let numericTarget;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

const spawn = async (name) => {
  const receipt = await mcp.call("agent_spawn", { name, command: fakeClaude(readyScreen), extra_args: [] });
  return receipt.agent_id;
};

describe("recipient references through the MCP tools", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  before(async () => {
    numericTarget = await spawn("numeric-target");
  });

  after(async () => {
    if (numericTarget != null) await mcp.call("agent_close", { agent_id: numericTarget }).catch(() => {});
  });

  it("a digit-only recipient string resolves as the agent id", async () => {
    const wake = await mcp.call("wake_set", {
      delay_seconds: 3600,
      body: "digit recipient",
      deliver_to: String(numericTarget),
    });
    assert.ok(wake.wake_id > 0);
    assert.equal(
      db.prepare("SELECT deliver_actor FROM wakes WHERE id = ?").get(wake.wake_id).deliver_actor,
      `agent:${numericTarget}`,
      "the persisted wake must target the requested row, not a name substring",
    );
  });

  it("a digit recipient matching no name resolves as a running agent id", async () => {
    const sent = await mcp.call("agent_send", { name: String(numericTarget), text: "digit id recipient" });
    assert.equal(sent.agent_id, numericTarget);
  });

  it("an agent literally named with digits still wins by name", async () => {
    const namedId = await spawn(String(numericTarget));
    try {
      const sent = await mcp.call("agent_send", { name: String(numericTarget), text: "numeric name wins" });
      assert.equal(sent.agent_id, namedId);
    } finally {
      await mcp.call("agent_close", { agent_id: namedId }).catch(() => {});
    }
  });

  it("an actor-id recipient (lead:N, agent:N) resolves", async () => {
    const sent = await mcp.call("agent_send", { name: `agent:${numericTarget}`, text: "actor id recipient" });
    assert.equal(sent.agent_id, numericTarget);
  });

  it("a digit or actor-id recipient from another project does not resolve", async () => {
    const foreignPath = join(dirs.tmp, "foreign-project");
    mkdirSync(foreignPath, { recursive: true });
    const foreign = db
      .prepare("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
      .get("foreign-project", realpathSync(foreignPath)).id;
    const foreignAgent = db
      .prepare(
        `INSERT INTO agents (project_id, name, command, cwd, kind, status, actor_id)
         VALUES (?, 'foreign', 'sleep', '/', 'agent', 'running', ?) RETURNING id`,
      )
      .get(foreign, "agent:9001895").id;

    await assert.rejects(
      mcp.call("agent_status", { name: String(foreignAgent), project_id: projectId }),
      new RegExp(`No running agent matching \\"${foreignAgent}\\" in project ${projectId}`),
    );
    await assert.rejects(
      mcp.call("agent_status", { name: "agent:9001895", project_id: projectId }),
      new RegExp(`No running agent matching \\"agent:9001895\\" in project ${projectId}`),
    );
  });

  it("a digit recipient that partially matches a name still resolves by name", async () => {
    const partialTarget = await spawn("w100000");
    try {
      const resolved = await mcp.call("agent_status", { name: "100000", project_id: projectId });
      assert.equal(resolved.agent_id, partialTarget);
    } finally {
      await mcp.call("agent_close", { agent_id: partialTarget }).catch(() => {});
    }
  });
});
