import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { isolateTmux, McpClient, scratchDirs, scratchGit } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent_list limit tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db } = await import("../dist/db.js");
const { sessionName } = await import("../dist/tmux.js");

let mcp;
let projectId;

const git = (...args) => scratchGit(dirs.projectDir, ...args);

before(async () => {
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("commit", "--allow-empty", "-m", "root", "--no-gpg-sign");

  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  projectId = (await mcp.call("whoami")).project.id;
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

function seedClosedAgent(name) {
  const info = db
    .prepare(
      "INSERT INTO agents (project_id, name, command, cwd, status, closed_at) VALUES (?, ?, 'sleep', '/tmp', 'closed', datetime('now'))",
    )
    .run(projectId, name);
  return Number(info.lastInsertRowid);
}

function seedRunningAgent(name) {
  const info = db
    .prepare("INSERT INTO agents (project_id, name, command, cwd) VALUES (?, ?, 'sleep', '/tmp')")
    .run(projectId, name);
  return Number(info.lastInsertRowid);
}

describe("agent_list limit and paging", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("bounds a closed listing to the default limit, newest first, with total and next_before_id set", async () => {
    const ids = [];
    for (let i = 0; i < 60; i++) ids.push(seedClosedAgent(`closed-bound-${i}`));

    const receipt = await mcp.call("agent_list", { include_closed: true });

    assert.equal(receipt.returned, 20, "returned must equal the default limit (20) when more rows exist");
    assert.equal(receipt.agents.length, 20);
    assert.equal(receipt.total, ids.length, "total must count every matching row, not just the page");

    const returnedIds = receipt.agents.map((a) => a.agent_id);
    for (let i = 1; i < returnedIds.length; i++) {
      assert.ok(returnedIds[i - 1] > returnedIds[i], "closed rows must come back newest id first");
    }
    assert.equal(
      receipt.next_before_id,
      returnedIds[returnedIds.length - 1],
      "next_before_id must be the smallest id on the page, the ORDER BY id DESC boundary",
    );
  });

  it("before_id pages through the remaining rows with no overlap and no gap", async () => {
    const before = (await mcp.call("agent_list", { include_closed: true, limit: 1 })).total;
    const ids = [];
    for (let i = 0; i < 60; i++) ids.push(seedClosedAgent(`closed-page-${i}`));
    const expectedTotal = before + ids.length;

    const seen = [];
    let beforeId;
    let pages = 0;
    for (;;) {
      const receipt = await mcp.call(
        "agent_list",
        beforeId === undefined
          ? { include_closed: true, limit: 20 }
          : { include_closed: true, limit: 20, before_id: beforeId },
      );
      pages++;
      assert.equal(receipt.total, expectedTotal, "total must stay the full count on every page");
      for (const a of receipt.agents) seen.push(a.agent_id);
      beforeId = receipt.next_before_id;
      if (beforeId === undefined) break;
      assert.ok(pages < 30, "pagination did not terminate");
    }

    const seededIds = new Set(ids);
    const seenOfSeeded = seen.filter((id) => seededIds.has(id));
    assert.equal(
      new Set(seenOfSeeded).size,
      seenOfSeeded.length,
      "no id from this seed set may be returned twice across pages",
    );
    for (const id of ids) {
      assert.ok(seen.includes(id), `id ${id} from this seed set must appear on some page`);
    }
  });

  it("rejects a limit above 100, the ceiling that keeps a single page inside a tool result", async () => {
    await assert.rejects(
      () => mcp.call("agent_list", { include_closed: true, limit: 101 }),
      /Too big|100/,
      "limit must be capped at 100, not the old 500 - 500 closed rows at ~1.1k chars each overflows a tool result",
    );
  });

  it("a running-only listing stays complete and ascending, unaffected by closed-listing paging", async () => {
    const ids = [seedRunningAgent("run-a"), seedRunningAgent("run-b"), seedRunningAgent("run-c")];
    for (let i = 0; i < 60; i++) seedClosedAgent(`closed-noise-${i}`);

    const receipt = await mcp.call("agent_list", {});

    const returnedIds = receipt.agents.map((a) => a.agent_id).filter((id) => ids.includes(id));
    assert.deepEqual(returnedIds, [...ids].sort((a, b) => a - b), "running-only stays ascending by id");
    assert.equal(receipt.agents.every((a) => a.status !== "closed"), true, "closed rows must not leak in");
    assert.equal(receipt.total, receipt.agents.length, "running-only total is the full running count");
    assert.equal(receipt.returned, receipt.agents.length);
    assert.equal(receipt.next_before_id, undefined, "running-only listing is never truncated");
  });
});
