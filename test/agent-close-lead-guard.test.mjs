import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

// PR #68 review gate finding, verified against the code. Issue #27 gave the
// lead a real agents row, which makes it a valid target for every generic
// agent_* tool: findAgent (src/tools/agents.ts) selects any RUNNING row in
// the project by name, with no kind filter. Before this lane that lookup
// simply found nothing for "lead". confirm_self does not help here either -
// it only fires when the CALLER is closing itself (agent.actor_id ===
// currentActor()), not when one actor closes a DIFFERENT one. So any worker
// could call agent_close({name: "lead"}) and silently end the one session
// with no supervisor above it.
//
// agent_send, agent_output and agent_status stay open on a lead:
// addressability is the point of #27's design (issue #27's L4 fix round,
// DECISION 4 - counselors recommended a blanket kind='agent' filter in
// findAgent and the lead rejected it for exactly this reason). Only the
// verbs that are DESTRUCTIVE or NONSENSICAL for a lead are refused:
// agent_close here, agent_rename (test/agent-rename-lead-guard.test.mjs) and
// wake_when_idle (test/wake-when-idle-lead-guard.test.mjs) elsewhere.
//
// Issue #27's L4 fix round R9, todo 176 item 2. agent_close used to refuse
// ANY lead target outright, unconditionally - which is why this file used
// to seed every lead row with a target no server has ever heard of
// ('%not-a-real-pane') and expect a refusal regardless. That target now
// reads as CONFIRMED DEAD (a real tmux server answers "can't find pane",
// not "unreachable"), which is exactly the new retirement path, so the
// refusal tests below need a genuinely LIVE pane instead: a lead row is
// immortal otherwise (the janitor exempts kind='lead', DECISION 3, and
// nothing else can ever close one), which is what made `hive restore`
// latch shut permanently on any store that ever ran a lead (todo 165, then
// todo 176's own finding after R8's liveness-probing attempt). The refusal
// itself is unchanged in spirit: nothing supervises a LIVE lead, so ending
// its session has to be a decision made from its own terminal.

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
    session = sessionName(projectId);
  });

  after(async () => {
    await mcp.close();
    cleanup(session);
  });

  // idx_agents_running_name allows only one RUNNING "lead" per project, and
  // each test's own seeded row survives a refused close (it must still be
  // running) - so the next test's seed has to clear the last one first,
  // rather than colliding with it.
  beforeEach(() => {
    db.prepare("DELETE FROM agents WHERE project_id = ? AND kind = 'lead'").run(projectId);
  });

  // A target no real tmux server has ever heard of: list-panes answers
  // "can't find pane", which reads as CONFIRMED dead, not unreachable -
  // exactly the state the new retirement path exists for.
  function seedDeadLeadRow() {
    return db
      .prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, 'lead:999', 'lead', '%not-a-real-pane', 'claude', ?, 'lead', 'running')
         RETURNING id`,
      )
      .get(projectId, dirs.projectDir).id;
  }

  // A genuinely live pane, so agent_close's own probe finds it alive - the
  // still-refused case. One shared session across this describe block's
  // "live" tests; each seeds a fresh row against whatever pane currently
  // exists there.
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
      // Issue #27's L4 fix round R10, todo 182 item 3 (opus F6). /lead.*live/
      // also matches probeFailed's "tmux could not be probed, so liveness is
      // unknown" - a null probe leaves the row running and the pane alive
      // too, so the other two assertions below would still pass, making the
      // whole test vacuous under exactly the flake (a failed probe) it exists
      // to catch. /still live/ pins the actual refusal text and costs
      // nothing.
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
      // Same fix as the test above: /still live/, not /lead.*live/, which
      // also matches probeFailed's "liveness is unknown" text.
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
    // Issue #27's L4 fix round R10, todo 182 item 3 (opus). findAgent's
    // closed-row message used to say "Spawn a new worker" unconditionally -
    // impossible advice for a retired LEAD, since "lead" stays reserved
    // (isReservedAgentName) and agent_spawn refuses it outright. Newly
    // reachable at all because todo 176 let agent_close retire a
    // confirmed-dead lead in the first place; before that a lead row could
    // never be closed, so this branch could never see one.
    const leadId = seedDeadLeadRow();
    const closed = await mcp.call("agent_close", { name: "lead" });
    assert.equal(closed.closed, true);
    assert.equal(db.prepare("SELECT status FROM agents WHERE id = ?").get(leadId).status, "closed");

    await assert.rejects(mcp.call("agent_output", { name: "lead" }), /Run `hive lead` to start a new one/);
  });

  it("still closes an ordinary worker, the accept case for this guard", async () => {
    // No fake claude needed: a plain command is enough to prove agent_close's
    // normal path still works once a kind check sits in front of it.
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
    // Issue #27's L4 fix round R10, todo 180. Before the fix targetLive('')
    // read TRUE (tmux resolves an empty target to the caller's own current
    // session rather than erroring), so a '' lead row read as live forever:
    // this exact close would have hit the "pane is still live" refusal
    // instead, and the row would have been immortal - defeating todo 176's
    // whole retirement path.
    //
    // A real session has to exist for that old bug to bite at all - "no
    // server running" already answered false honestly, even before this
    // fix. spawnLivePane stands in for some OTHER live agent sharing the
    // server, so this test cannot pass by accident just because nothing is
    // running.
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
    // Issue #27's L4 fix round R10, todo 180's second consequence. Before
    // the fix, isLive('') read TRUE, so agent_close's kill branch ran `tmux
    // kill-pane -t ''` against a row that was never aimed at any real pane -
    // and an empty target resolves to whichever window tmux considers
    // CURRENT for the session, not to any specific row. Reproduced on this
    // file's own isolated scratch server, never the real one: agent_spawn's
    // own window claims "current" first, then a second window (the
    // "bystander", standing in for some other live agent) takes it over -
    // the exact position a buggy kill-pane -t '' would reach instead of the
    // row it was actually aimed at.
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

      // Simulate the row losing track of its own pane (the shape a lost CAS
      // or a stale row leaves): overwrite tmux_target to '' directly, the
      // same value ensureLeadRow (src/cli.ts) seeds a fresh row with.
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

  // Issue #27's L4 fix round R10, todo 181 item 1 (BOTH SEATS). R9's own
  // residual text asserted "closing this one deliberately (a human choosing
  // to run agent_close)" as if that were already enforced. It was not:
  // nothing checked the caller, so a WORKER could retire a lead exactly like
  // a human at a terminal. Every test above in this file runs as the default
  // McpClient, which sets no HIVE_AGENT_ID and so is a `user:<name>` (human)
  // caller - these tests are the ones that actually exercise the new gate.
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
      // A different actor id than seedDeadLeadRow's own ('lead:999'), or this
      // would exercise confirm_self instead of the guard under test.
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
