import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { McpClient, isolateTmux, scratchDirs, sleep } from "./helpers.mjs";

// The MCP server drives tmux for the agent tools; isolate first.
const { cleanup: cleanupTmux } = isolateTmux("the store tests");
after(() => cleanupTmux());

// One server instance drives the whole file; a second instance with its own
// actor id joins for the lease-contention case. Both share one database.
const dirs = scratchDirs();
let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
});

after(async () => {
  await mcp.close();
});

describe("identity and scope", () => {
  it("resolves the working directory as the project", async () => {
    const who = await mcp.call("whoami");
    assert.equal(who.project.path, dirs.projectDir);
    assert.match(who.actor_id, /^user:/);
  });
});

describe("pads", () => {
  it("creates, appends, edits, and reads back", async () => {
    const created = await mcp.call("pad_write", { name: "plan", content: "line one" });
    assert.equal(created.revision, 1);

    const appended = await mcp.call("pad_append", {
      pad_id: created.pad_id,
      content: "line two",
      expected_revision: 1,
    });
    assert.equal(appended.revision, 2);

    const edited = await mcp.call("pad_edit", {
      pad_id: created.pad_id,
      old_text: "line two",
      new_text: "line 2",
      expected_revision: 2,
    });
    assert.equal(edited.revision, 3);

    const read = await mcp.call("pad_read", { name: "plan" });
    assert.equal(read.revision, 3);
    assert.match(read.content, /line one/);
    assert.match(read.content, /line 2/);
  });

  it("rejects writes with a stale revision", async () => {
    const pad = await mcp.call("pad_read", { name: "plan" });
    await assert.rejects(
      mcp.call("pad_append", {
        pad_id: pad.pad_id,
        content: "conflict",
        expected_revision: pad.revision - 1,
      }),
      /Revision mismatch/,
    );
  });

  it("frees the name on archive and keeps content readable by id", async () => {
    const pad = await mcp.call("pad_read", { name: "plan" });
    await mcp.call("pad_archive", { pad_id: pad.pad_id });
    const fresh = await mcp.call("pad_write", { name: "plan", content: "new board" });
    assert.notEqual(fresh.pad_id, pad.pad_id);
    const old = await mcp.call("pad_read", { pad_id: pad.pad_id });
    assert.match(old.content, /line one/);
  });
});

describe("todos", () => {
  let blocker;
  let dependent;

  it("hides blocked work from the dispatch filter", async () => {
    blocker = (await mcp.call("todo_create", { title: "first" })).todo_id;
    dependent = (await mcp.call("todo_create", { title: "second", blocked_by: [blocker] })).todo_id;

    const dispatchable = await mcp.call("todo_list", { is_blocked: false, status: "open" });
    const ids = dispatchable.todos.map((t) => t.todo_id);
    assert.ok(ids.includes(blocker));
    assert.ok(!ids.includes(dependent));
  });

  it("rejects dependency cycles", async () => {
    await assert.rejects(
      mcp.call("todo_block", { todo_id: blocker, blocker_id: dependent }),
      /cycle/i,
    );
  });

  it("reports newly unblocked todos on completion", async () => {
    const done = await mcp.call("todo_complete", { todo_id: blocker });
    assert.deepEqual(done.newly_unblocked, [dependent]);
  });
});

describe("kv", () => {
  it("round-trips values and deletes", async () => {
    await mcp.call("kv_set", { key: "port", value: 5173 });
    const got = await mcp.call("kv_get", { key: "port" });
    assert.equal(got.found, true);
    assert.equal(got.value, 5173);

    await mcp.call("kv_delete", { key: "port" });
    const gone = await mcp.call("kv_get", { key: "port" });
    assert.equal(gone.found, false);
  });

  it("expires TTL values on their own", async () => {
    await mcp.call("kv_set", { key: "ephemeral", value: "x", ttl_seconds: 1 });
    // Expiry compares datetime('now') at whole-second granularity with a
    // strict <, so a 1s TTL can outlive its deadline by up to ~2s.
    await sleep(2300);
    const gone = await mcp.call("kv_get", { key: "ephemeral" });
    assert.equal(gone.found, false);
  });
});

describe("leases", () => {
  it("blocks other actors and extends for the owner", async () => {
    const acquired = await mcp.call("lease_acquire", { key: "file:src/db.ts", ttl_seconds: 30 });
    assert.equal(acquired.acquired, true);

    const again = await mcp.call("lease_acquire", { key: "file:src/db.ts", ttl_seconds: 60 });
    assert.equal(again.acquired, true);
    assert.equal(again.extended, true);

    const rival = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "agent:rival", HIVE_AGENT_NAME: "rival" },
    });
    await rival.start();
    try {
      const denied = await rival.call("lease_acquire", { key: "file:src/db.ts", ttl_seconds: 30 });
      assert.equal(denied.acquired, false);
    } finally {
      await rival.close();
    }

    await mcp.call("lease_release", { key: "file:src/db.ts" });
  });
});
