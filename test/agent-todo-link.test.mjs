import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isolateTmux, liveAgentRow, makeFakeClaude, McpClient, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the agent todo-link tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { addProject } = await import("../dist/context.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();

let mcp;
const fakeClaude = makeFakeClaude(dirs.tmp);
const linkOf = (id) => db.prepare("SELECT todo_id FROM agents WHERE id = ?").get(id).todo_id;
const agentCount = () => db.prepare("SELECT COUNT(*) AS n FROM agents").get().n;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir, env: { HIVE_SPAWN_READY_MS: "1" } });
  await mcp.start();
});

after(async () => {
  await mcp.close();
  cleanup(sessionName());
});

describe("agent_spawn todo_id", { skip: hasTmux ? false : "tmux is not installed" }, () => {
  it("same-project link is stored and read back", async () => {
    const todo = await mcp.call("todo_create", { title: "linked lane" });
    const receipt = await mcp.call("agent_spawn", { name: "link-one", command: fakeClaude(), todo_id: todo.todo_id });
    assert.equal(linkOf(receipt.agent_id), todo.todo_id);
    assert.equal(Object.hasOwn(receipt, "todo_id"), false, "the slim spawn receipt is unchanged");
    const listed = (await mcp.call("agent_list")).agents.find((a) => a.name === "link-one");
    assert.equal(listed.todo_id, todo.todo_id);
    assert.equal((await mcp.call("agent_status", { name: "link-one" })).todo_id, todo.todo_id);
    assert.equal((await mcp.call("todo_get", { todo_id: todo.todo_id })).status, "open", "linking changes no todo status");
    await mcp.call("agent_close", { name: "link-one" });
  });

  it("omission and resume preserve nullable link", async () => {
    const plain = await mcp.call("agent_spawn", { name: "link-none", command: fakeClaude() });
    assert.equal(linkOf(plain.agent_id), null);
    const todo = await mcp.call("todo_create", { title: "resume lane" });
    const linked = await mcp.call("agent_spawn", { name: "link-resume", command: fakeClaude(), todo_id: todo.todo_id });
    await liveAgentRow(mcp, "link-resume");
    await mcp.call("agent_park", { name: "link-resume" });
    await mcp.call("agent_resume", { name: "link-resume" });
    assert.equal(linkOf(linked.agent_id), todo.todo_id);
    await mcp.call("agent_close", { name: "link-resume" });
    await mcp.call("agent_close", { name: "link-none" });
  });

  it("foreign missing archived ids refuse before row or pane creation", async () => {
    const other = addProject(mkdtempSync(join(tmpdir(), "hive-link-other-")), "link-other");
    const foreign = db
      .prepare("INSERT INTO todos (project_id, title) VALUES (?, 'foreign')")
      .run(other.id).lastInsertRowid;
    const archived = await mcp.call("todo_create", { title: "gone lane" });
    await mcp.call("todo_archive", { todo_id: archived.todo_id });
    const before = agentCount();
    for (const [todoId, pattern] of [
      [Number(foreign), /not a todo in project/],
      [999999, /not a todo in project/],
      [archived.todo_id, /archived/],
    ]) {
      await assert.rejects(mcp.call("agent_spawn", { name: "link-refused", command: fakeClaude(), todo_id: todoId }), pattern);
    }
    assert.equal(agentCount(), before, "a refused link creates no agents row");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents WHERE name = 'link-refused'").get().n, 0);
  });

  it("todo delete nulls link without closing worker", async () => {
    const todo = await mcp.call("todo_create", { title: "doomed lane" });
    const receipt = await mcp.call("agent_spawn", { name: "link-doomed", command: fakeClaude(), todo_id: todo.todo_id });
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM todos WHERE id = ?").run(todo.todo_id);
    assert.equal(linkOf(receipt.agent_id), null);
    assert.equal((await liveAgentRow(mcp, "link-doomed")).alive, true);
    await mcp.call("agent_close", { name: "link-doomed" });
  });

  it("undeclared spawn key remains refused", async () => {
    await assert.rejects(
      mcp.call("agent_spawn", { name: "link-extra", command: fakeClaude(), todo_slug: "x" }),
      /todo_slug|Unrecognized key|unrecognized/i,
    );
  });
});
