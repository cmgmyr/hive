import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

import { isolateTmux, makeFakeClaude, McpClient, scratchDirs, until } from "./helpers.mjs";

// Todo 274 (topology-3c). resolveDelivery's own-session lookup
// (src/tools/wakes.ts) had no ORDER BY on `WHERE actor_id = ? AND status =
// 'running'` - the identical shape splitTargetWindow (src/spawn.ts) already
// carries `ORDER BY id DESC LIMIT 1` for, and for the identical reason (its
// own comment): two running rows should never share an actor_id, but if that
// invariant is ever wrong, a `.get()` with no ordering picks whichever
// SQLite hands back first - in practice, for this unindexed shape, the
// LOWER (older) rowid. Found by 3b's own /simplify altitude pass and
// deferred to this lane because it opens the file.
//
// This also stands in for todo 274's migration question: pane ids are
// SERVER-scoped, so the topology change (one session, not one per project)
// does not invalidate a recorded %N by itself - this test runs entirely
// against the new, store-scoped session (sessionName() takes no project
// argument) and proves delivery still lands on the correct real pane rather
// than assuming it.
const { hasTmux, cleanup } = isolateTmux("resolveDelivery's ORDER BY (todo 274)");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

const capture = (target) => execFileSync("tmux", ["capture-pane", "-p", "-t", target]).toString();

describe(
  "resolveDelivery's own-session lookup",
  { skip: hasTmux ? false : "tmux is not installed" },
  () => {
    let mcp;
    // A fixed actor_id, not the McpClient's own default (`user:<os user>`,
    // shared with every other file's default-identity server) - each seeded
    // row below must belong to THIS test's actor and no other test's.
    const actorId = "user:wake-order-test";

    before(async () => {
      execFileSync("tmux", [
        "new-session", "-d", "-s", sessionName(), "-x", "220", "-y", "50", "-c", dirs.projectDir,
      ]);
      mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_AGENT_ID: actorId } });
      await mcp.start();
    });

    after(async () => {
      await mcp.close();
      cleanup(sessionName());
    });

    it("targets the newer row's live pane, not an older dead row sharing the same actor_id", async () => {
      const projectId = (await mcp.call("whoami")).project.id;

      // The LOWER-id row: same actor_id, a syntactically valid pane id that
      // is not actually live - the exact shape splitTargetWindow's own
      // comment names (a closed lead's stale tmux_target surviving
      // alongside a fresh running row). Inserted FIRST, so a `.get()` with
      // no ORDER BY - SQLite's practical default for this unindexed scan is
      // insertion/rowid order - would pick this one.
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, ?, 'wake-order-dead', '%99999', 'claude', ?, 'agent', 'running')`,
      ).run(projectId, actorId, dirs.projectDir);

      // The HIGHER-id row: same actor_id, a REAL live pane.
      const fakeClaude = makeFakeClaude(dirs.tmp);
      const pane = execFileSync("tmux", [
        "new-window", "-P", "-F", "#{pane_id}", "-t", `=${sessionName()}`, "-c", dirs.projectDir,
        fakeClaude("sleep 600"),
      ]).toString().trim();
      db.prepare(
        `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status)
         VALUES (?, ?, 'wake-order-live', ?, 'claude', ?, 'agent', 'running')`,
      ).run(projectId, actorId, pane, dirs.projectDir);

      // No deliver_to: resolveDelivery's OWN-session branch, the one under
      // test, is reached only when the caller wakes itself.
      const wake = await mcp.call("wake_set", { delay_seconds: 1, body: "WAKE-ORDER marker" });

      const recorded = db.prepare("SELECT deliver_pane FROM timers WHERE id = ?").get(wake.wake_id);
      assert.equal(
        recorded.deliver_pane,
        pane,
        "must target the newer (higher id) row's live pane, not the older dead row sharing this actor_id",
      );

      // Not just the column: fire it for real and read the delivery back off
      // the actual pane's terminal.
      const delivered = await until(() => capture(pane).includes("WAKE-ORDER marker"), 15000);
      assert.ok(delivered, "the wake must actually be typed into the correct pane, not just recorded there");
    });
  },
);
