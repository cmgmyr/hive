import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { assertScratchStore, isolateTmux, McpClient, paneField, scratchDirs } from "./helpers.mjs";

const { hasTmux, cleanup: cleanupTmux } = isolateTmux("the prune tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db } = await import("../dist/db.js");

const { ACTOR_OWNER_COLUMNS } = await import("../dist/tools/meta.js");
const { PROJECT_OWNER_TABLES } = await import("../dist/projectRemove.js");
const { tmuxSocketPath } = await import("../dist/tmux.js");

const BYSTANDER = `prune-bystander-${process.pid}`;
let pane = "%unset";
let pid = "";
const bystanderAlive = () => paneField(pane, "#{pane_pid}") === pid;
const runningRow = (projectId, name, kind, panePid) =>
  db
    .prepare(
      "INSERT INTO agents (project_id, name, kind, command, cwd, status, tmux_target, tmux_socket, pane_pid) VALUES (?, ?, ?, 'sleep', '/tmp', 'running', ?, ?, ?) RETURNING id",
    )
    .get(projectId, name, kind, pane, tmuxSocketPath(process.env.TMUX, process.env.TMUX_TMPDIR), panePid).id;

before(() => {
  if (!hasTmux) return;
  execFileSync("tmux", ["new-session", "-d", "-s", BYSTANDER, "sleep 600"], { stdio: "ignore" });
  pane = execFileSync("tmux", ["list-panes", "-t", `=${BYSTANDER}`, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
  pid = paneField(pane, "#{pane_pid}");
});

after(() => cleanupTmux(BYSTANDER));

const BACKDATE_PAST_LIVENESS = "-150 seconds";

function backdateLastSeen(actorId) {
  db.prepare("UPDATE actors SET last_seen_at = datetime('now', ?) WHERE id = ?").run(
    BACKDATE_PAST_LIVENESS,
    actorId,
  );
}

function seedProjectOwnerRow(table, projectId, ownerActorId) {
  switch (table) {
    case "pads":
      db.prepare("INSERT INTO pads (project_id, name) VALUES (?, 'x')").run(projectId);
      return;
    case "todos":
      db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'x')").run(projectId);
      return;
    case "kv":
      db.prepare("INSERT INTO kv (project_id, key, value) VALUES (?, 'k', 'v')").run(projectId);
      return;
    case "leases":
      db.prepare(
        "INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, 'k', ?, datetime('now', '+1 day'))",
      ).run(projectId, ownerActorId);
      return;
    case "agents":
      db.prepare("INSERT INTO agents (project_id, name, command, cwd) VALUES (?, 'x', 'sleep', '/tmp')").run(
        projectId,
      );
      return;
    case "wakes":
      db.prepare(
        "INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, 'x', 'x', 'x', 'x')",
      ).run(projectId);
      return;
    case "command_trust":
      db.prepare("INSERT INTO command_trust (project_id, name, config_hash) VALUES (?, 'x', 'x')").run(projectId);
      return;
    default:
      throw new Error(`test/prune.test.mjs has no seed for PROJECT_OWNER_TABLES entry "${table}" - add one`);
  }
}

function seedActorOwnerRow(table, column, actorId, homeProjectId, sharedTodoId) {
  switch (`${table}.${column}`) {
    case "agents.actor_id":

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
    case "leases.owner":
      db.prepare(
        "INSERT INTO leases (project_id, lock_key, owner, expires_at) VALUES (?, ?, ?, datetime('now', '+1 day'))",
      ).run(homeProjectId, `key-${actorId}`, actorId);
      return;
    case "pads.updated_by":
      db.prepare("INSERT INTO pads (project_id, name, updated_by) VALUES (?, ?, ?)").run(
        homeProjectId,
        `pad-${actorId}`,
        actorId,
      );
      return;
    case "wakes.owner":
      db.prepare(
        "INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, ?, 'x', 'x', 'x')",
      ).run(homeProjectId, actorId);
      return;
    case "wakes.deliver_actor":
      db.prepare(
        "INSERT INTO wakes (project_id, owner, body, deliver_actor, deliver_pane) VALUES (?, 'x', 'x', ?, 'x')",
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

      await solo.close();
    }
  });

  it("PROJECT_OWNER_TABLES is exactly the audited list from #97 (todo 235) - a change here must be deliberate", () => {
    assert.deepEqual(
      [...PROJECT_OWNER_TABLES].sort(),
      ["agents", "command_trust", "kv", "leases", "pads", "todos", "wakes"],
    );
  });

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

  it("project_id removes exactly that empty project, refuses a non-empty one naming its rows, and refuses the caller's own", async () => {
    const ownerActorId = (await mcp.call("whoami")).actor_id;
    const home = (await mcp.call("whoami")).project.id;
    const targetEmpty = await mcp.call("project_add", { path: scratchDirs().projectDir });
    const bystanderEmpty = await mcp.call("project_add", { path: scratchDirs().projectDir });
    const full = await mcp.call("project_add", { path: scratchDirs().projectDir });
    seedProjectOwnerRow("todos", full.id, ownerActorId);
    seedProjectOwnerRow("kv", full.id, ownerActorId);

    const result = await mcp.call("project_prune", { project_id: targetEmpty.id });
    assert.deepEqual(result.deleted, [{ id: targetEmpty.id, name: targetEmpty.name }]);
    assert.ok(!db.prepare("SELECT id FROM projects WHERE id = ?").get(targetEmpty.id));
    assert.ok(db.prepare("SELECT id FROM projects WHERE id = ?").get(bystanderEmpty.id), "another empty project must not be swept");

    await assert.rejects(mcp.call("project_prune", { project_id: full.id }), /not empty.*todos: 1, kv: 1/);
    assert.ok(db.prepare("SELECT id FROM projects WHERE id = ?").get(full.id));
    await assert.rejects(mcp.call("project_prune", { project_id: home }), /caller's own project/);
    await assert.rejects(mcp.call("project_prune", { project_id: 999999 }), /no project 999999/);
    await assert.rejects(mcp.call("project_prune", { project_id: 1, bogus: 1 }), /bogus|Unrecognized/i);
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

        rawDb?.close();
        await lockMcp.close();
      }
    });
  });
});

describe("project_prune confirm_name", () => {
  const projectExists = (id) => db.prepare("SELECT id FROM projects WHERE id = ?").get(id) !== undefined;
  async function nonEmptyProject() {
    const owner = (await mcp.call("whoami")).actor_id;
    const project = await mcp.call("project_add", { path: scratchDirs().projectDir });
    seedProjectOwnerRow("todos", project.id, owner);
    seedProjectOwnerRow("kv", project.id, owner);
    return project;
  }

  it("removes a non-empty project when confirm_name equals its name, reporting counts and a snapshot", async () => {
    const target = await nonEmptyProject();
    const result = await mcp.call("project_prune", { project_id: target.id, confirm_name: target.name });
    assert.deepEqual(result.deleted, [{ id: target.id, name: target.name }]);
    assert.deepEqual(result.counts, { todos: 1, kv: 1 });
    assert.match(result.snapshot, /backups/);
    assert.ok(!projectExists(target.id));
  });

  it("refuses a mismatched confirm_name, names the real name, and deletes nothing", async () => {
    const target = await nonEmptyProject();
    await assert.rejects(
      mcp.call("project_prune", { project_id: target.id, confirm_name: target.name + "x" }),
      new RegExp(`whose name is "${target.name}"`),
    );
    assert.ok(projectExists(target.id));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM todos WHERE project_id = ?").get(target.id).n, 1);
  });

  it("refuses confirm_name without project_id and deletes nothing", async () => {
    const target = await nonEmptyProject();
    await assert.rejects(mcp.call("project_prune", { confirm_name: target.name }), /confirm_name needs project_id/);
    assert.ok(projectExists(target.id));
  });

  it("refuses both the cwd project and the selected project, even after project_select moves away from the cwd one", async () => {
    const solo = new McpClient({ cwd: scratchDirs().projectDir, dataDir: dirs.dataDir });
    try {
      await solo.start();
      const cwdProject = (await solo.call("whoami")).project;
      db.prepare("INSERT INTO todos (project_id, title) VALUES (?, 'x')").run(cwdProject.id);
      const other = await solo.call("project_add", { path: scratchDirs().projectDir });
      await solo.call("project_select", { project_id: other.id });
      await assert.rejects(solo.call("project_prune", { project_id: cwdProject.id, confirm_name: cwdProject.name }), /caller's own project/);
      await assert.rejects(solo.call("project_prune", { project_id: other.id, confirm_name: other.name }), /caller's own project/);
      assert.ok(projectExists(cwdProject.id) && projectExists(other.id));
      const swept = await solo.call("project_prune", {});
      assert.ok(!swept.deleted.some((p) => p.id === other.id));
      assert.ok(projectExists(other.id));
    } finally {
      await solo.close();
    }
  });

  it("refuses the caller's own project even with the right name", async () => {
    const who = await mcp.call("whoami");
    await assert.rejects(
      mcp.call("project_prune", { project_id: who.project.id, confirm_name: who.project.name }),
      /caller's own project/,
    );
    assert.ok(projectExists(who.project.id));
  });

  it("without confirm_name, project_id on a non-empty project still refuses and now names confirm_name", async () => {
    const target = await nonEmptyProject();
    await assert.rejects(mcp.call("project_prune", { project_id: target.id }), /not empty.*todos: 1, kv: 1.*confirm_name/s);
    assert.ok(projectExists(target.id));
  });

  it("the no-argument sweep still skips a non-empty project", async () => {
    const target = await nonEmptyProject();
    const result = await mcp.call("project_prune");
    assert.ok(!result.deleted.some((p) => p.id === target.id));
    assert.ok(projectExists(target.id));
  });

  it("refuses under HIVE_PROJECT_LOCK=1 and deletes nothing", async () => {
    const target = await nonEmptyProject();
    const locked = new McpClient({ cwd: scratchDirs().projectDir, dataDir: dirs.dataDir, env: { HIVE_PROJECT_LOCK: "1" } });
    try {
      await locked.start();
      await assert.rejects(
        locked.call("project_prune", { project_id: target.id, confirm_name: target.name }),
        /HIVE_PROJECT_LOCK/,
      );
    } finally {
      await locked.close();
    }
    assert.ok(projectExists(target.id));
  });

  it("refuses a target whose running worker owns a live pane and deletes nothing", { skip: !hasTmux && "tmux is not installed" }, async () => {
    const target = await nonEmptyProject();
    runningRow(target.id, "busy", "agent", pid);
    await assert.rejects(
      mcp.call("project_prune", { project_id: target.id, confirm_name: target.name }),
      /running agents: busy \(agent \d+, owns a live pane\).*agent_close first/s,
    );
    assert.ok(projectExists(target.id));
  });

  it("refuses a target whose lead has no recorded pane pid, with the row_only hint", { skip: !hasTmux && "tmux is not installed" }, async () => {
    const target = await nonEmptyProject();
    const id = runningRow(target.id, "lead", "lead", "");
    await assert.rejects(
      mcp.call("project_prune", { project_id: target.id, confirm_name: target.name }),
      new RegExp(`pane identity unknown[\\s\\S]*agent_close\\(\\{agent_id: ${id}, row_only: true\\}\\)`),
    );
    assert.ok(projectExists(target.id));
  });

  it("removes a target whose running lead row names a reissued pane, leaving the pane's new owner alive", { skip: !hasTmux && "tmux is not installed" }, async () => {
    const target = await nonEmptyProject();
    runningRow(target.id, "lead", "lead", "1");
    await mcp.call("project_prune", { project_id: target.id, confirm_name: target.name });
    assert.ok(!projectExists(target.id));
    assert.ok(bystanderAlive());
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

  it("holds back a recently-seen actor that owns nothing yet, separately from the caller's own actor", async () => {
    const live = new McpClient({
      cwd: dirs.projectDir,
      dataDir: dirs.dataDir,
      env: { HIVE_AGENT_ID: "agent:prune-live", HIVE_AGENT_NAME: "prune-live" },
    });
    await live.start();
    await live.call("whoami");

    await live.close();

    const result = await mcp.call("actor_prune");

    assert.ok(!result.deleted.some((a) => a.id === "agent:prune-live"));
    assert.ok(
      result.held_back_live.some((a) => a.id === "agent:prune-live"),
      `a recently-seen, ownerless actor must be held back and reported, got ${JSON.stringify(result)}`,
    );
    assert.ok(db.prepare("SELECT id FROM actors WHERE id = ?").get("agent:prune-live"));
  });

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

  it("ACTOR_OWNER_COLUMNS is exactly the audited list from #97 (todo 235) - a change here must be deliberate", () => {
    assert.deepEqual(
      ACTOR_OWNER_COLUMNS.map(([table, column]) => `${table}.${column}`).sort(),
      [
        "agent_state_log.actor_id",
        "agents.actor_id",
        "agents.parent_actor_id",
        "kv.updated_by",
        "leases.owner",
        "pads.updated_by",
        "wakes.deliver_actor",
        "wakes.owner",
        "todo_comments.author",
        "todos.locked_by",
      ].sort(),
    );
  });

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
