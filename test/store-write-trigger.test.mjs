import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { McpClient, isolateTmux, scratchDirs } from "./helpers.mjs";

const { cleanup: cleanupTmux } = isolateTmux("the store-write-trigger tests");
after(() => cleanupTmux());

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
migrate();

function seedProject(path) {
  db.prepare("INSERT INTO projects (name, path) VALUES (?, ?)").run("p", path);
  return db.prepare("SELECT id FROM projects WHERE path = ?").get(path).id;
}

const STALE_UPDATED_AT = "2020-01-01 00:00:00";

function seedPad(projectId, name, content) {
  return db
    .prepare(
      "INSERT INTO scratchpads (project_id, name, content, updated_at) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(projectId, name, content, STALE_UPDATED_AT).id;
}

function padRow(id) {
  return db.prepare("SELECT * FROM scratchpads WHERE id = ?").get(id);
}

describe("the scratchpads content-vs-updated_at trigger", () => {
  it("aborts the exact incident shape: a name-addressed UPDATE across two projects, changing content, leaving updated_at alone", () => {

    const hive = seedProject("/scratch/hive");
    const orchard = seedProject("/scratch/orchard");
    const hivePadId = seedPad(hive, "board", "hive's own board content");
    const orchardPadId = seedPad(orchard, "board", "orchard's own board content");
    const before1 = padRow(hivePadId);
    const before2 = padRow(orchardPadId);

    assert.throws(
      () =>
        db
          .prepare("UPDATE scratchpads SET content = ?, revision = revision + 1 WHERE name = ?")
          .run("hive's content, copied over both projects", "board"),
      /leaves updated_at unchanged/,
    );

    assert.deepEqual(padRow(hivePadId), before1);
    assert.deepEqual(padRow(orchardPadId), before2);
  });

  it("names hive pad --save and primary-key addressing in the error", () => {
    const projectId = seedProject("/scratch/message-check");
    const padId = seedPad(projectId, "board", "original");
    assert.throws(
      () =>
        db
          .prepare("UPDATE scratchpads SET content = ?, revision = revision + 1 WHERE id = ?")
          .run("new content", padId),
      /hive pad <name> --save <file>/,
    );
    assert.throws(
      () =>
        db
          .prepare("UPDATE scratchpads SET content = ?, revision = revision + 1 WHERE id = ?")
          .run("new content", padId),
      /BY PRIMARY KEY/,
    );
  });

  it("does not fire on two legitimate content-changing writes to the same row inside one wall-clock second", () => {

    const projectId = seedProject("/scratch/same-second");
    const padId = db
      .prepare("INSERT INTO scratchpads (project_id, name, content) VALUES (?, 'board', 'v1') RETURNING id")
      .get(projectId).id;
    assert.doesNotThrow(() =>
      db
        .prepare("UPDATE scratchpads SET content = ?, revision = revision + 1, updated_at = datetime('now') WHERE id = ?")
        .run("v2", padId),
    );
    assert.equal(padRow(padId).content, "v2");
  });

  it("KNOWN RESIDUAL: does not catch a bypass landing in the same second as the row's own last legitimate write", () => {

    const projectId = seedProject("/scratch/seed-then-rewrite");
    const padId = db
      .prepare(
        "INSERT INTO scratchpads (project_id, name, content, updated_at) VALUES (?, 'board', 'seeded', datetime('now')) RETURNING id",
      )
      .get(projectId).id;
    assert.doesNotThrow(
      () => db.prepare("UPDATE scratchpads SET content = ?, revision = revision + 1 WHERE id = ?").run("BYPASSED", padId),
      "if this throws, the same-second gap has closed - update the migration comment too, do not just delete this test",
    );
    assert.equal(padRow(padId).content, "BYPASSED");
  });

  it("does not fire when content is unchanged, however updated_at moves", () => {
    const projectId = seedProject("/scratch/touch-only");
    const padId = seedPad(projectId, "board", "same content throughout");
    assert.doesNotThrow(() =>
      db.prepare("UPDATE scratchpads SET revision = revision + 1, updated_at = datetime('now') WHERE id = ?").run(padId),
    );
  });
});

describe("the todos and kv content-vs-updated_at triggers", () => {
  it("aborts a raw UPDATE that changes todos.title or body without stamping updated_at", () => {
    const projectId = seedProject("/scratch/todos-raw");
    const todoId = db
      .prepare("INSERT INTO todos (project_id, title, body, updated_at) VALUES (?, ?, ?, ?) RETURNING id")
      .get(projectId, "original title", "original body", STALE_UPDATED_AT).id;
    assert.throws(
      () => db.prepare("UPDATE todos SET title = ? WHERE id = ?").run("hijacked title", todoId),
      /todos\.title or todos\.body but leaves updated_at unchanged/,
    );
    assert.throws(
      () => db.prepare("UPDATE todos SET body = ? WHERE id = ?").run("hijacked body", todoId),
      /todos\.title or todos\.body but leaves updated_at unchanged/,
    );
  });

  it("aborts a raw UPDATE that changes kv.value without stamping updated_at, and names the project_id+key primary key", () => {
    const projectId = seedProject("/scratch/kv-raw");
    db.prepare(
      "INSERT INTO kv (project_id, key, value, updated_at) VALUES (?, 'config', '\"original\"', ?)",
    ).run(projectId, STALE_UPDATED_AT);
    assert.throws(
      () => db.prepare("UPDATE kv SET value = ? WHERE key = 'config'").run('"hijacked"'),
      /primary key is \(project_id, key\)/,
    );
  });
});

describe("legitimate writes through the real tool layer still work", () => {
  let mcp;

  before(async () => {
    mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
    await mcp.start();
  });

  after(async () => {
    await mcp.close();
  });

  it("pad_write, pad_edit and pad_append all still change content", async () => {
    const created = await mcp.call("pad_write", { name: "legit-pad", content: "line one" });
    assert.equal(created.revision, 1);

    const appended = await mcp.call("pad_append", { pad_id: created.pad_id, content: "line two" });
    assert.equal(appended.revision, 2);

    const edited = await mcp.call("pad_edit", {
      pad_id: created.pad_id,
      old_text: "line one",
      new_text: "line ONE",
    });
    assert.equal(edited.revision, 3);

    const read = await mcp.call("pad_read", { pad_id: created.pad_id });
    assert.equal(read.content, "line ONE\nline two");
    assert.equal(read.revision, 3);
  });

  it("pad --save's underlying overwrite (pad_write with pad_id + expected_revision) still works", async () => {
    const created = await mcp.call("pad_write", { name: "save-pad", content: "before" });
    const overwritten = await mcp.call("pad_write", {
      name: "save-pad",
      pad_id: created.pad_id,
      expected_revision: created.revision,
      content: "after",
    });
    assert.equal(overwritten.revision, 2);
    const read = await mcp.call("pad_read", { pad_id: created.pad_id });
    assert.equal(read.content, "after");
  });

  it("todo_update still changes title and body", async () => {
    const created = await mcp.call("todo_create", { title: "before title", body: "before body" });
    await mcp.call("todo_update", { todo_id: created.todo_id, title: "after title", body: "after body" });
    const detail = await mcp.call("todo_get", { todo_id: created.todo_id });
    assert.equal(detail.title, "after title");
  });

  it("kv_set still changes value, including overwriting an existing key", async () => {
    await mcp.call("kv_set", { key: "flag", value: "first" });
    await mcp.call("kv_set", { key: "flag", value: "second" });
    const read = await mcp.call("kv_get", { key: "flag" });
    assert.equal(read.value, "second");
  });
});
