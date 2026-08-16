import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_close lead guard tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

describe("agent_close and the lead's retirement path", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  let mcp;
  let projectId;
  let session;

  before(async () => {
    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
    projectId = (await mcp.call("whoami")).project.id;
    session = sessionName();
  });

  after(async () => {
    await mcp.close();
    cleanup(session);
  });

  beforeEach(() => {
    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
  });

  function seedDeadLeadRow() {
    return db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'lead:999', 'lead', '%not-a-real-pane', 'claude', ?, 'lead', 'running')
         RETURNING id`,
      )
      .get(projectId, dirs.projectDir).id;
  }

  function spawnLivePane() {
    const fakeClaude = makeFakeClaude(dirs.tmp);
    const claudePath = fakeClaude("sleep 600");
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", dirs.projectDir, "claude"], {
      env: { ...process.env, PATH: `${dirname(claudePath)}:${process.env.PATH}` },
      stdio: "ignore",
    });
    return execFileSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"], { encoding: "utf8" })
      .trim()
      .split("\n")[0];
  }

  function seedLiveLeadRow() {
    const pane = spawnLivePane();
    const id = db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'lead:999', 'lead', ?, 'claude', ?, 'lead', 'running')
         RETURNING id`,
      )
      .get(projectId, pane, dirs.projectDir).id;
    return { id, pane };
  }

  it("refuses to close a kind='lead' row whose pane is LIVE, addressed by name", async () => {
    const { id: leadId, pane } = seedLiveLeadRow();
    try {

      await assert.rejects(mcp.call("agent_close", { name: "lead" }), /still live/is);

      assert.equal(
        db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status,
        "running",
        "a refused close must not touch the row",
      );
      assert.doesNotThrow(
        () => execFileSync("tmux", ["list-panes", "-t", pane], { stdio: "ignore" }),
        "the live pane must not have been killed either",
      );
    } finally {
      execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    }
  });

  it("refuses to close a kind='lead' row whose pane is LIVE, addressed by agent_id too", async () => {
    const { id: leadId } = seedLiveLeadRow();
    try {

      await assert.rejects(mcp.call("agent_close", { agent_id: leadId }), /still live/is);

      assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status, "running");
    } finally {
      execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    }
  });

  it("retires a kind='lead' row whose pane is confirmed DEAD, the new escape from an immortal row", async () => {
    const leadId = seedDeadLeadRow();

    const closed = await mcp.call("agent_close", { name: "lead" });

    assert.equal(closed.closed, true);
    assert.equal(
      db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status,
      "closed",
      "a confirmed-dead lead must actually be retirable now, not refused forever",
    );
  });

  it("tells you to `hive lead`, not spawn a worker, once the retired lead's name is addressed again (todo 182 item 3)", async () => {

    const leadId = seedDeadLeadRow();
    const closed = await mcp.call("agent_close", { name: "lead" });
    assert.equal(closed.closed, true);
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status, "closed");

    await assert.rejects(mcp.call("agent_output", { name: "lead" }), /Run `hive lead` to start a new one/);
  });

  it("still closes an ordinary worker, the accept case for this guard", async () => {

    await mcp.call("agent_spawn", { name: "ordinary-worker", command: "sleep", extra_args: ["600"] });

    const closed = await mcp.call("agent_close", { name: "ordinary-worker" });

    assert.equal(closed.closed, true);
    assert.equal(
      db.prepare("SELECT status FROM agents WHERE project_id = ? AND name = ?").get(projectId, "ordinary-worker")
        .status,
      "closed",
    );
  });

  it("retires a kind='lead' row whose tmux_target is EMPTY (todo 180), the shape a died-mid-INSERT `hive lead` leaves", async () => {

    const bystanderPane = spawnLivePane();
    try {
      const leadId = db
        .prepare(
          `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
           VALUES (?, 'lead:999', 'lead', '', 'claude', ?, 'lead', 'running')
           RETURNING id`,
        )
        .get(projectId, dirs.projectDir).id;

      const closed = await mcp.call("agent_close", { name: "lead" });

      assert.equal(closed.closed, true);
      assert.equal(
        db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status,
        "closed",
        "an empty-target lead row must be retirable, not immortal",
      );
      assert.doesNotThrow(
        () => execFileSync("tmux", ["list-panes", "-t", bystanderPane], { stdio: "ignore" }),
        "retiring the empty-target row must not have touched the bystander's pane either",
      );
    } finally {
      execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    }
  });

  it("does not kill any pane when closing a worker row with an EMPTY tmux_target (todo 180)", async () => {

    try {
      await mcp.call("agent_spawn", { name: "empty-target-worker", command: "sleep", extra_args: ["600"] });
      const bystanderPane = execFileSync(
        "tmux",
        [
          "new-window",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          `=${session}`,
          "-n",
          "bystander",
          "-c",
          dirs.projectDir,
          "sleep 600",
        ],
        { encoding: "utf8" },
      ).trim();

      db.prepare("UPDATE agents SET tmux_target = '' WHERE project_id = ? AND name = ?").run(
        projectId,
        "empty-target-worker",
      );

      const closed = await mcp.call("agent_close", { name: "empty-target-worker" });

      assert.equal(closed.closed, true);
      assert.equal(
        db.prepare("SELECT status FROM agents WHERE project_id = ? AND name = ?").get(projectId, "empty-target-worker")
          .status,
        "closed",
      );
      assert.doesNotThrow(
        () => execFileSync("tmux", ["list-panes", "-t", bystanderPane], { stdio: "ignore" }),
        "a close aimed at an empty target must not have killed the bystander pane",
      );
    } finally {
      execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
    }
  });

  describe("refuses a WORKER caller on a lead target, live or dead (todo 181 item 1)", () => {
    it("refuses a worker retiring a lead whose pane is confirmed DEAD - the exact path that used to succeed", async () => {
      const leadId = seedDeadLeadRow();
      const workerMcp = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "agent:999" },
      });
      await workerMcp.start();
      try {
        await assert.rejects(
          workerMcp.call("agent_close", { name: "lead" }),
          /worker this project spawned may not close it/,
        );
        assert.equal(
          db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status,
          "running",
          "a refused worker close must not touch the row",
        );
      } finally {
        await workerMcp.close();
      }
    });

    it("refuses a worker closing a lead whose pane is LIVE too, not only the dead-retirement path", async () => {
      const { id: leadId, pane } = seedLiveLeadRow();
      const workerMcp = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "agent:999" },
      });
      await workerMcp.start();
      try {
        await assert.rejects(
          workerMcp.call("agent_close", { name: "lead" }),
          /worker this project spawned may not close it/,
        );
        assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status, "running");
        assert.doesNotThrow(() => execFileSync("tmux", ["list-panes", "-t", pane], { stdio: "ignore" }));
      } finally {
        await workerMcp.close();
        execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore" });
      }
    });

    it("still allows a PEER LEAD caller to retire a confirmed-dead lead - the escape hatch this fix must not remove", async () => {

      const leadId = seedDeadLeadRow();
      const peerLeadMcp = new McpClient({
        cwd: dirs.projectDir,
        dataDir: dirs.dataDir,
        env: { HIVE_AGENT_ID: "lead:1" },
      });
      await peerLeadMcp.start();
      try {
        const closed = await peerLeadMcp.call("agent_close", { name: "lead" });
        assert.equal(closed.closed, true);
        assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status, "closed");
      } finally {
        await peerLeadMcp.close();
      }
    });
  });
});
