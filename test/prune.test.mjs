import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { assertScratchStore, isolateTmux, McpClient, scratchDirs } from "./helpers.mjs";

// The MCP server's scheduler can reach tmux even when a test never calls an
// agent_* tool; isolate first, same as every other file that starts a real
// server (test/CLAUDE.md).
const { cleanup: cleanupTmux } = isolateTmux("the prune tests");

// This file's whole point is DELETE statements against project and actor
// rows, so it proves the store is scratch before opening it directly, same
// as test/backup.test.mjs and test/store-isolation.test.mjs.
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db } = await import("../dist/db.js");
// Imported from the built tool file, not copied here, so a table or column
// added to either list picks up test coverage automatically instead of
// silently going unchecked - counselors round on PR #100, finding 5.
const { PROJECT_OWNER_TABLES, ACTOR_OWNER_COLUMNS } = await import("../dist/tools/meta.js");

// actor_prune's liveness guard (src/tools/meta.ts) holds back any actor
// touched within ACTOR_LIVENESS_WINDOW_MS (2 * TOUCH_INTERVAL_MS, 60s) of
// the prune call. Every actor row defaults last_seen_at to "now" at INSERT
// time (src/db.ts), so a survivor seeded to prove the OWNERSHIP check works
// must be backdated well past that window - otherwise it would survive
// because it looks freshly active, not because of the row proving ownership,
// and a mutation that broke the ownership check would go uncaught. Comfortably
// past 60s; not tied to the exact constant since this only needs to clear it.
const BACKDATE_PAST_LIVENESS = "-150 seconds";

function backdateLastSeen(actorId) {
  db.prepare("UPDATE actors SET last_seen_at = datetime('now', ?) WHERE id = ?").run(
    BACKDATE_PAST_LIVENESS,
    actorId,
  );
}

// One insert per PROJECT_OWNER_TABLES entry, each satisfying only that
// table's NOT NULL columns. A table added to the list with no case here
// throws loudly at test time rather than silently shipping unchecked -
// seeding needs domain knowledge (which columns are safe placeholders) that
// can't be derived generically from the schema.
function seedProjectOwnerRow(table, projectId, ownerActorId) {
  switch (table) {
    case "scratchpads":
      db.prepare("INSERT INTO scratchpads (project_id, name) VALUES (?, 'x')").run(projectId);
      return;
    case "todos":
      db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'x')").run(projectId);
      return;
    case "kv":
      db.prepare("INSERT INTO kv (project_id, key, value) VALUES (?, 'k', 'v')").run(projectId);
      return;
    case "locks":
      db.prepare(
        "INSERT INTO locks (project_id, lock_key, owner, expires_at) VALUES (?, 'k', ?, datetime('now', '+1 day'))",
      ).run(projectId, ownerActorId);
      return;
    case "agents":
      db.prepare("INSERT INTO agents (project_id, name, command, cwd) VALUES (?, 'x', 'sleep', '/tmp')").run(
        projectId,
      );
      return;
    case "timers":
      db.prepare(
        "INSERT INTO timers (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, 'x', 'x', 'x', 'x')",
      ).run(projectId);
      return;
    case "command_trust":
      db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'x', 'x')").run(projectId);
      return;
    default:
      throw new Error(`test/prune.test.mjs has no seed for PROJECT_OWNER_TABLES entry "${table}" - add one`);
  }
}

// Same idea as seedProjectOwnerRow, one insert per ACTOR_OWNER_COLUMNS pair.
function seedActorOwnerRow(table, column, actorId, homeProjectId, sharedTodoId) {
  switch (`${table}.${column}`) {
    case "agents.actor_id":
      // name must be unique per (project_id, name) among running agents
      // (idx_agents_running_name); actorId is already unique per case here.
      db.prepare(
        "INSERT INTO agents (project_id, actor_id, name, command, cwd) VALUES (?, ?, ?, 'sleep', '/tmp')",
      ).run(homeProjectId, actorId, actorId);
      return;
    case "agents.parent_actor_id":
      db.prepare(
        "INSERT INTO agents (project_id, parent_actor_id, name, command, cwd) VALUES (?, ?, ?, 'sleep', '/tmp')",
      ).run(homeProjectId, actorId, actorId);
      return;
    case "todos.locked_by":
      db.prepare("INSERT INTO todos (project_id, title, locked_by) VALUES (?, 'x', ?)").run(homeProjectId, actorId);
      return;
    case "todo_comments.author":
      db.prepare("INSERT INTO todo_comments (todo_id, author, body) VALUES (?, ?, 'x')").run(sharedTodoId, actorId);
      return;
    case "kv.updated_by":
      db.prepare("INSERT INTO kv (project_id, key, value, updated_by) VALUES (?, ?, 'v', ?)").run(
        homeProjectId,
        `k-${actorId}`,
        actorId,
      );
      return;
    case "locks.owner":
      db.prepare(
        "INSERT INTO locks (project_id, lock_key, owner, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))",
      ).run(homeProjectId, `key-${actorId}`, actorId);
      return;
    case "scratchpads.updated_by":
      db.prepare("INSERT INTO scratchpads (project_id, name, updated_by) VALUES (?, ?, ?)").run(
        homeProjectId,
        `pad-${actorId}`,
        actorId,
      );
      return;
    case "timers.owner":
      db.prepare(
        "INSERT INTO timers (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, ?, 'x', 'x', 'x')",
      ).run(homeProjectId, actorId);
      return;
    case "timers.deliver_actor":
      db.prepare(
        "INSERT INTO timers (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, 'x', 'x', ?, 'x')",
      ).run(homeProjectId, actorId);
      return;
    case "agent_state_log.actor_id":
      db.prepare("INSERT INTO agent_state_log (actor_id, event, state) VALUES (?, 'test', 'test')").run(actorId);
      return;
    default:
      throw new Error(
        `test/prune.test.mjs has no seed for ACTOR_OWNER_COLUMNS entry "${table}.${column}" - add one`,
      );
  }
}

let mcp;

before(async () => {
  mcp = new McpClient({ cwd: dirs.projectDir, dataDir: dirs.dataDir });
  await mcp.start();
  // Both prune tools sweep every registered project or actor in the store,
  // not just this file's fixtures - whoami alone writes no owned row, so
  // without this the primary project would itself look empty and get swept
  // by the very first prune call below, taking every other test in this
  // file down with it.
  await mcp.call("todo_create", { title: "keep this project non-empty" });
});

after(async () => {
  await mcp.close();
  cleanupTmux();
});

describe("project_prune", () => {
  it("holds back the caller's own project even when empty, and says so in the receipt", async () => {
    const solo = new McpClient({ cwd: scratchDirs().projectDir, dataDir: dirs.dataDir });
    try {
      await solo.start();
      const who = await solo.call("whoami");

      const result = await solo.call("project_prune");

      assert.equal(result.held_back.project_id, who.project.id);
      assert.ok(!result.deleted.some((p) => p.id === who.project.id));
      assert.ok(
        db.prepare("SELECT id FROM projects WHERE id = ?").get(who.project.id),
        "the caller's own empty project must survive its own prune call",
      );
    } finally {
      // In a finally, not after the assertions: a failed assertion must not
      // skip this and leak the child process. McpClient's stdout listener
      // keeps this file's event loop alive until the process exits, so a
      // leaked client hangs the whole suite instead of just failing one
      // test - found the hard way while mutation-testing this file.
      await solo.close();
    }
  });

  // Mutation-tested and found NECESSARY, not decorative: the table-driven
  // test below iterates PROJECT_OWNER_TABLES itself, so removing an entry
  // from the list shrinks the test's own coverage right along with the
  // check's - the iteration alone gave zero discriminating power against
  // exactly the mutation that matters most (an edited list). This pins the
  // list's actual contents independently, so dropping or renaming an entry
  // reddens HERE even though the table-driven test would stay silent.
  it("PROJECT_OWNER_TABLES is exactly the audited list from #97 (todo 235) - a change here must be deliberate", () => {
    assert.deepEqual(
      [...PROJECT_OWNER_TABLES].sort(),
      ["agents", "command_trust", "kv", "locks", "scratchpads", "timers", "todos"],
    );
  });

  // The whole point of finding 5 (PR #100 counselors round): the old version
  // of this test protected exactly one table (kv), so it passed with six of
  // seven PROJECT_OWNER_TABLES entries deleted from the list. This seeds one
  // survivor per table, iterating the real exported list. Discriminates a
  // broken CHECK (existsWhere, the .some() call) even though it cannot, on
  // its own, discriminate an edited LIST - the assertion above covers that.
  it("deletes an empty project, but keeps one owning a row in each PROJECT_OWNER_TABLES table", async () => {
    const ownerActorId = (await mcp.call("whoami")).actor_id;
    const empty = await mcp.call("project_add", { path: scratchDirs().projectDir });
    const survivors = [];
    for (const table of PROJECT_OWNER_TABLES) {
      const project = await mcp.call("project_add", { path: scratchDirs().projectDir });
      seedProjectOwnerRow(table, project.id, ownerActorId);
      survivors.push({ table, project });
    }

    const result = await mcp.call("project_prune");

    assert.ok(result.deleted.some((p) => p.id === empty.id));
    assert.ok(!db.prepare("SELECT id FROM projects WHERE id = ?").get(empty.id));
    for (const { table, project } of survivors) {
      assert.ok(
        !result.deleted.some((p) => p.id === project.id),
        `a project owning only a ${table} row must not be reported as deleted`,
      );
      assert.ok(
        db.prepare("SELECT id FROM projects WHERE id = ?").get(project.id),
        `a project owning only a ${table} row must survive`,
      );
    }
  });

  it("refuses under HIVE_PROJECT_LOCK=1, since it sweeps the whole store", async () => {
    const locked = new McpClient({
      cwd: scratchDirs().projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_PROJECT_LOCK: "1" },
    });
    try {
      await locked.start();
      await assert.rejects(locked.call("project_prune"), /HIVE_PROJECT_LOCK/);
    } finally {
      await locked.close();
    }
  });

  // Counselors round on PR #100, finding 4: a per-row transaction can still
  // throw, and the fix must not let that erase the receipt entirely. This
  // forces a REAL failure with a genuine competing write lock from a second
  // connection (no test-only hook in production code), in its own scratch
  // store so no other candidate from earlier tests shares the wait.
  describe("resilience to a real per-row failure", () => {
    it("reports a blocked row in errors instead of discarding the rest of the receipt", async () => {
      const lockDirs = scratchDirs();
      const lockMcp = new McpClient({ cwd: lockDirs.projectDir, dataDir: lockDirs.dataDir });
      let rawDb;
      try {
        await lockMcp.start();
        await lockMcp.call("todo_create", { title: "keep this project non-empty" });
        const target = await lockMcp.call("project_add", { path: scratchDirs().projectDir });

        rawDb = new Database(join(lockDirs.dataDir, "hive.db"));
        rawDb.pragma("busy_timeout = 0");
        rawDb.prepare("BEGIN IMMEDIATE").run();

        let result;
        try {
          result = await lockMcp.call("project_prune");
        } finally {
          rawDb.prepare("ROLLBACK").run();
        }

        assert.ok(!result.deleted.some((p) => p.id === target.id));
        assert.ok(
          result.errors?.some((e) => e.id === target.id),
          `blocked row should be reported in errors, got ${JSON.stringify(result)}`,
        );
        assert.ok(
          rawDb.prepare("SELECT id FROM projects WHERE id = ?").get(target.id),
          "a candidate whose transaction failed must still exist, not be half-deleted",
        );
      } finally {
        // Outer try/finally, same reasoning as the other McpClient tests in
        // this file: a failed assertion above must still close lockMcp, or
        // its leaked stdout listener hangs the whole suite rather than just
        // failing this one test.
        rawDb?.close();
        await lockMcp.close();
      }
    });
  });
});

describe("actor_prune", () => {
  it("holds back the caller's own actor even when it owns nothing, and says so in the receipt", async () => {
    const solo = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "agent:prune-solo", HIVE_AGENT_NAME: "prune-solo" },
    });
    try {
      await solo.start();
      const who = await solo.call("whoami");
      assert.equal(who.actor_id, "agent:prune-solo");

      const result = await solo.call("actor_prune");

      assert.equal(result.held_back.actor_id, "agent:prune-solo");
      assert.ok(!result.deleted.some((a) => a.id === "agent:prune-solo"));
      assert.ok(db.prepare("SELECT id FROM actors WHERE id = ?").get("agent:prune-solo"));
    } finally {
      await solo.close();
    }
  });

  it("refuses under HIVE_PROJECT_LOCK=1, since it sweeps the whole store", async () => {
    const locked = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_PROJECT_LOCK: "1" },
    });
    try {
      await locked.start();
      await assert.rejects(locked.call("actor_prune"), /HIVE_PROJECT_LOCK/);
    } finally {
      await locked.close();
    }
  });

  // Counselors round on PR #100, finding 1 (P1): ownership is not the whole
  // liveness question. A manually-identified session that has called a tool
  // but not yet written anything owned must be held back, not treated as
  // inert, and reported separately from the caller's-own-actor case.
  it("holds back a recently-seen actor that owns nothing yet, separately from the caller's own actor", async () => {
    const live = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "agent:prune-live", HIVE_AGENT_NAME: "prune-live" },
    });
    await live.start();
    await live.call("whoami"); // creates the actor row; last_seen_at = now; owns nothing
    // Closed here, before any assertion: an assertion that throws must not
    // skip this and leak the child - McpClient's stdout listener keeps this
    // file's event loop alive until the process exits, so a leaked one hangs
    // the whole suite instead of just failing the one test. Closing the
    // process does not touch the actor ROW the prune call below reads.
    await live.close();

    const result = await mcp.call("actor_prune");

    assert.ok(!result.deleted.some((a) => a.id === "agent:prune-live"));
    assert.ok(
      result.held_back_live.some((a) => a.id === "agent:prune-live"),
      `a recently-seen, ownerless actor must be held back and reported, got ${JSON.stringify(result)}`,
    );
    assert.ok(db.prepare("SELECT id FROM actors WHERE id = ?").get("agent:prune-live"));
  });

  // The realistic version, via real McpClient sessions and real tool calls
  // rather than raw inserts, matching the issue's own motivating example
  // (five real actors kept for real todo_comments they wrote). Both actors
  // are backdated past the liveness window so this proves the OWNERSHIP
  // check keeps the commenter, not the new liveness guard - todo_comments
  // .author has no foreign key, so it is the one column a miss silently
  // orphans.
  it("deletes an inert actor, but keeps one whose only trace is a todo_comments.author row", async () => {
    const commenter = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "agent:prune-commenter", HIVE_AGENT_NAME: "prune-commenter" },
    });
    await commenter.start();
    const todo = await mcp.call("todo_create", { title: "needs a comment" });
    await commenter.call("todo_comment", { todo_id: todo.todo_id, body: "handoff notes" });
    await commenter.close();
    backdateLastSeen("agent:prune-commenter");

    const inert = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "agent:prune-inert", HIVE_AGENT_NAME: "prune-inert" },
    });
    await inert.start();
    await inert.call("whoami");
    await inert.close();
    backdateLastSeen("agent:prune-inert");

    const result = await mcp.call("actor_prune");

    assert.ok(result.deleted.some((a) => a.id === "agent:prune-inert"));
    assert.ok(!result.deleted.some((a) => a.id === "agent:prune-commenter"));
    assert.ok(!db.prepare("SELECT id FROM actors WHERE id = ?").get("agent:prune-inert"));
    assert.ok(
      db.prepare("SELECT id FROM actors WHERE id = ?").get("agent:prune-commenter"),
      "an actor whose only trace is todo_comments.author must survive",
    );
    assert.ok(
      db.prepare("SELECT 1 FROM todo_comments WHERE author = ?").get("agent:prune-commenter"),
      "the comment itself, the record of what the worker did, must survive too",
    );
  });

  // Same reasoning as PROJECT_OWNER_TABLES's own pin above: the table-driven
  // test below iterates this list itself, so it cannot catch a REMOVED
  // entry on its own (both the check and the test's coverage would shrink
  // together) - mutation-tested and confirmed. This pins the contents
  // independently.
  it("ACTOR_OWNER_COLUMNS is exactly the audited list from #97 (todo 235) - a change here must be deliberate", () => {
    assert.deepEqual(
      ACTOR_OWNER_COLUMNS.map(([table, column]) => `${table}.${column}`).sort(),
      [
        "agent_state_log.actor_id",
        "agents.actor_id",
        "agents.parent_actor_id",
        "kv.updated_by",
        "locks.owner",
        "scratchpads.updated_by",
        "timers.deliver_actor",
        "timers.owner",
        "todo_comments.author",
        "todos.locked_by",
      ].sort(),
    );
  });

  // The exhaustive version of the above, covering every ACTOR_OWNER_COLUMNS
  // entry, not just todo_comments.author - counselors round on PR #100,
  // finding 5. The old single-column test passed with nine of the ten
  // columns deleted from the list; this seeds one survivor per column,
  // iterating the real exported list, all backdated past the liveness
  // window so only ownership is under test. Discriminates a broken CHECK,
  // not an edited LIST - the assertion above covers that.
  it("deletes an inert actor, but keeps one owning a row in each ACTOR_OWNER_COLUMNS column", async () => {
    const homeProjectId = (await mcp.call("whoami")).project.id;
    const sharedTodo = await mcp.call("todo_create", { title: "shared todo for locked_by / author" });

    const survivors = [];
    for (const [table, column] of ACTOR_OWNER_COLUMNS) {
      const actorId = `agent:owner-${table}-${column}`;
      db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(actorId, actorId);
      seedActorOwnerRow(table, column, actorId, homeProjectId, sharedTodo.todo_id);
      backdateLastSeen(actorId);
      survivors.push({ table, column, actorId });
    }

    const inertId = "agent:table-driven-inert";
    db.prepare("INSERT INTO actors (id, name, kind) VALUES (?, ?, 'agent')").run(inertId, inertId);
    backdateLastSeen(inertId);

    const result = await mcp.call("actor_prune");

    assert.ok(result.deleted.some((a) => a.id === inertId));
    assert.ok(!db.prepare("SELECT id FROM actors WHERE id = ?").get(inertId));
    for (const { table, column, actorId } of survivors) {
      assert.ok(
        !result.deleted.some((a) => a.id === actorId),
        `an actor owning only a ${table}.${column} row must not be reported as deleted`,
      );
      assert.ok(
        db.prepare("SELECT id FROM actors WHERE id = ?").get(actorId),
        `an actor owning only a ${table}.${column} row must survive`,
      );
    }
  });
});
