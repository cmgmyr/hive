import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  createLiveAndDialogPanes,
  isolateTmux,
  paneField,
  resolvedTmuxSocket,
  tmux,
  runCli,
  scratchDirs,
  scratchGit,
} from "./helpers.mjs";

const { hasTmux, cleanup } = isolateTmux("the crew tests");

const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { addProject } = await import("../dist/context.js");
const { classifyActivity, collectCrew, readCommitsAhead, reviewSkillsOf } = await import("../dist/crew.js");
const { sessionName } = await import("../dist/tmux.js");
const { readRecentToolCalls } = await import("../dist/transcript.js");
const { harnessFor, registerHarness, unregisterHarness } = await import("../dist/harnesses.js");
migrate();

after(() => {
  try {
    tmux("kill-session", "-t", "=crew-dialog");
  } catch {}
  cleanup(sessionName());
});

const project = addProject(dirs.projectDir, "crew-main");
const other = addProject(mkdtempSync(join(tmpdir(), "hive-crew-other-")), "crew-other");
const NOW = new Date("2026-10-08T12:00:00.000Z");

let seq = 0;
function agent(o = {}) {
  const n = ++seq;
  return db
    .prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, tmux_socket, pane_pid, command, cwd, kind, status,
                           agent_state, state_changed_at, session_id, transcript_path, resumed_at, model, todo_id, created_at)
       VALUES (@project_id, @actor_id, @name, @tmux_target, @tmux_socket, @pane_pid, @command, @cwd, @kind, @status,
               @agent_state, @state_changed_at, @session_id, @transcript_path, @resumed_at, @model, @todo_id, @created_at)
       RETURNING id`,
    )
    .get({
      project_id: project.id,
      actor_id: `agent:${900 + n}`,
      name: `w${n}`,
      tmux_target: "%999",
      tmux_socket: "",
      pane_pid: "",
      command: "claude",
      cwd: dirs.projectDir,
      kind: "agent",
      status: "running",
      agent_state: "working",
      state_changed_at: "2026-10-08 11:50:00",
      session_id: "",
      transcript_path: "",
      resumed_at: "",
      model: "opus",
      todo_id: null,
      created_at: "2026-10-08 11:00:00",
      ...o,
    }).id;
}

function todo(o = {}) {
  return db
    .prepare(
      `INSERT INTO todos (project_id, title, status, tags, slug, archived_at)
       VALUES (@project_id, @title, @status, @tags, @slug, @archived_at) RETURNING id`,
    )
    .get({ project_id: project.id, title: "t", status: "open", tags: "[]", slug: "", archived_at: null, ...o }).id;
}

function wake(o = {}) {
  return db
    .prepare(
      `INSERT INTO wakes (project_id, owner, body, kind, watch_scope, deliver_actor, deliver_pane, due_at, max_wait_at, fired_at, cancelled_at)
       VALUES (@project_id, 'lead:1', @body, @kind, @watch_scope, 'lead:1', '%1', @due_at, @max_wait_at, @fired_at, @cancelled_at)
       RETURNING id`,
    )
    .get({
      project_id: project.id,
      body: "wake",
      kind: "delay",
      watch_scope: null,
      due_at: null,
      max_wait_at: null,
      fired_at: null,
      cancelled_at: null,
      ...o,
    }).id;
}

function dumpStore(database) {
  const names = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, database.prepare(`SELECT * FROM "${n}"`).all()]));
}

const call = (name, input = {}, at = null) => ({ name, input, at });
const bash = (command, at = null) => call("Bash", { command }, at);
const labelOf = (command, vars = {}) => classifyActivity([bash(command)], vars).label;

describe("hive crew --json exits", () => {
  it("unknown cwd and bad args exit 1 with no JSON", async () => {
    const stray = mkdtempSync(join(tmpdir(), "hive-crew-stray-"));
    const cases = [
      [["crew", "--json"], stray],
      [["crew"], dirs.projectDir],
      [["crew", "--json", "extra"], dirs.projectDir],
      [["crew", "--human"], dirs.projectDir],
    ];
    for (const [args, cwd] of cases) {
      const r = await runCli(args, { cwd, dataDir: dirs.dataDir, tmp: dirs.tmp });
      assert.equal(r.code, 1, `${args.join(" ")} in ${cwd}`);
      assert.equal(r.stdout, "", "no partial JSON on stdout");
      assert.match(r.stderr, /^hive crew: /);
    }
  });

  it("an unknown crew argument is refused the way every other command refuses one", async () => {
    const r = await runCli(["crew", "--json", "--human"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.equal(r.code, 1);
    assert.equal(r.stderr.trim(), 'hive crew: unknown argument "--human". Flags are --json.');
    const bare = await runCli(["crew"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.match(bare.stderr, /usage: hive crew --json/);
  });

  it("an unmigrated store exits 1 and is left with no tables", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "hive-crew-empty-")), "missing-data");
    const r = await runCli(["crew", "--json"], { cwd: dirs.projectDir, dataDir, tmp: dirs.tmp });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /no projects table/);
    assert.deepEqual(readdirSync(dataDir).filter((f) => !f.startsWith("hive.db")), [], "only the database the import opened");
    const raw = new Database(join(dataDir, "hive.db"), { readonly: true });
    assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), []);
    raw.close();
  });

  it("a store from before the todo link exits 1 naming the missing column and migrates nothing", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "hive-crew-old-")), "data");
    mkdirSync(dataDir, { recursive: true });
    const old = new Database(join(dataDir, "hive.db"));
    old.exec("CREATE TABLE projects (id INTEGER); CREATE TABLE agents (id INTEGER); CREATE TABLE todos (id INTEGER); CREATE TABLE wakes (id INTEGER);");
    old.close();
    const r = await runCli(["crew", "--json"], { cwd: dirs.projectDir, dataDir, tmp: dirs.tmp });
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /agents\.todo_id/);
    const raw = new Database(join(dataDir, "hive.db"), { readonly: true });
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 4);
    raw.close();
  });
});

describe("hive crew --json is read-only", () => {
  it("every table stays unchanged with dead agents and expired wakes", async () => {
    const t = todo({ status: "in_progress", slug: "dead lane" });
    agent({ name: "ghost", tmux_target: "%424242", agent_state: "working", todo_id: t });
    agent({ name: "ghost-wait", tmux_target: "%424243", agent_state: "waiting" });
    wake({ body: "overdue\nsecond line", due_at: "2020-01-01 00:00:00" });
    wake({ body: "watcher", kind: "idle_any", watch_scope: "project", max_wait_at: "2020-01-01 00:00:00" });
    db.pragma("wal_checkpoint(TRUNCATE)");
    const before = JSON.stringify(dumpStore(db));
    const filesBefore = readdirSync(dirs.dataDir).sort();

    const r = await runCli(["crew", "--json"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.equal(r.code, 0, r.stderr);
    const snapshot = JSON.parse(r.stdout);
    assert.equal(snapshot.schema_version, 1);
    assert.equal(snapshot.lanes.length >= 2, true);

    assert.equal(JSON.stringify(dumpStore(db)), before, "a janitor sweep would have closed the ghosts or fired the wake");
    assert.deepEqual(readdirSync(dirs.dataDir).sort(), filesBefore, "no backup, teardown record or new file");
    db.prepare("DELETE FROM agents").run();
    db.prepare("DELETE FROM wakes").run();
    db.prepare("DELETE FROM todos").run();
  });
});

describe("hive crew --json schema v1", () => {
  it("real CLI output has exactly the v1 key sets for snapshot lane worker activity wakes and needs_you", async () => {
    const linked = todo({ status: "in_progress", slug: "lane" });
    todo({ status: "in_progress", slug: "bare" });
    todo({ tags: '["needs-human"]', slug: "ask" });
    agent({ name: "schema-w", todo_id: linked });
    wake({ body: "next one", due_at: "2030-01-01 00:00:00" });
    wake({ body: "watcher", kind: "idle_any", watch_scope: "project", max_wait_at: "2030-01-01 00:00:00" });
    const r = await runCli(["crew", "--json"], { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp });
    assert.equal(r.code, 0, r.stderr);
    const snap = JSON.parse(r.stdout);
    const keys = (o) => Object.keys(o).sort();
    assert.deepEqual(keys(snap), ["context_checkpoint_percent", "lanes", "needs_you", "project", "read_at", "schema_version", "wakes"]);
    assert.deepEqual(keys(snap.project), ["id", "name"]);
    const staffed = snap.lanes.find((l) => l.worker);
    const unstaffed = snap.lanes.find((l) => !l.worker);
    assert.deepEqual(keys(staffed), ["todo", "worker"]);
    assert.deepEqual(keys(staffed.todo), ["id", "slug", "status"]);
    assert.deepEqual(keys(unstaffed), ["todo", "worker"]);
    assert.deepEqual(keys(staffed.worker), [
      "activity", "age_seconds", "commits_ahead", "context_fill", "created_at", "harness", "id", "model", "name",
      "session_id", "state", "state_changed_at", "your_turn",
    ]);
    assert.deepEqual(keys(staffed.worker.activity), ["label", "lower_bound", "since"]);
    assert.deepEqual(keys(snap.needs_you[0]), ["id", "slug"]);
    assert.deepEqual(keys(snap.wakes), ["next", "pending", "watched_worker_ids", "watching"]);
    assert.deepEqual(keys(snap.wakes.next), ["due_at", "generated", "held", "id", "label"]);
    assert.deepEqual(keys(snap.wakes.watching[0]), ["id", "kind", "label", "max_wait_at", "scope"]);
    db.prepare("DELETE FROM agents").run();
    db.prepare("DELETE FROM wakes").run();
    db.prepare("DELETE FROM todos").run();
  });
});

describe("collectCrew rows", () => {
  it("infers unlinked workers from their latest in-progress todo comment and then their last pad update", (t) => {
    const older = todo({ status: "in_progress", slug: "older" });
    const newest = todo({ status: "in_progress", slug: "newest" });
    const open = todo({ status: "open", slug: "open-comment" });
    const actorId = "agent:inferred";
    db.prepare("INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, ?, 'a', ?)").run(older, actorId, "2026-10-08 10:00:00");
    db.prepare("INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, ?, 'b', ?)").run(newest, actorId, "2026-10-08 11:00:00");
    db.prepare("INSERT INTO todo_comments (todo_id, author, body, created_at) VALUES (?, ?, 'c', ?)").run(open, actorId, "2026-10-08 12:00:00");
    const workerId = agent({ name: "w-inferred", actor_id: actorId });
    const padActor = "agent:pad-only";
    db.prepare("INSERT INTO pads (project_id, name, content, updated_by, updated_at) VALUES (?, 'old-pad', 'x', ?, '2026-10-08 10:00:00')").run(project.id, padActor);
    db.prepare("INSERT INTO pads (project_id, name, content, updated_by, updated_at) VALUES (?, 'last-pad', 'y', ?, '2026-10-08 11:00:00')").run(project.id, padActor);
    const padWorkerId = agent({ name: "w-pad-only", actor_id: padActor });
    const explicitId = agent({ name: "w-explicit", actor_id: actorId, todo_id: older });
    t.after(() => {
      db.prepare("DELETE FROM agents").run();
      db.prepare("DELETE FROM pads").run();
      db.prepare("DELETE FROM todo_comments").run();
      db.prepare("DELETE FROM todos").run();
    });

    const before = db.prepare("SELECT todo_id FROM agents WHERE id IN (?, ?, ?) ORDER BY id").all(workerId, padWorkerId, explicitId);
    const lanes = collectCrew(project, NOW).lanes;
    const byName = Object.fromEntries(lanes.filter((l) => l.worker).map((l) => [l.worker.name, l]));
    assert.equal(byName["w-inferred"].todo.slug, "newest");
    assert.equal(byName["w-pad-only"].todo, null);
    assert.equal(byName["w-pad-only"].pad, "last-pad");
    assert.equal(byName["w-explicit"].todo.slug, "older");
    assert.equal(lanes.some((l) => l.todo?.id === newest && !l.worker), false);
    assert.deepEqual(db.prepare("SELECT todo_id FROM agents WHERE id IN (?, ?, ?) ORDER BY id").all(workerId, padWorkerId, explicitId), before);
  });

  it("project-safe joins retain unlinked duplicate staffed and unstaffed rows", () => {
    const mine = todo({ status: "in_progress", slug: "mine" });
    const shared = todo({ status: "in_progress", slug: "shared" });
    const gone = todo({ status: "in_progress", slug: "archived", archived_at: "2026-10-01 00:00:00" });
    const lonely = todo({ status: "in_progress", slug: "lonely" });
    const done = todo({ status: "completed", slug: "done" });
    const foreign = db
      .prepare("INSERT INTO todos (project_id, title, status, slug) VALUES (?, 'f', 'in_progress', 'foreign') RETURNING id")
      .get(other.id).id;
    const w = {
      mine: agent({ name: "w-mine", todo_id: mine }),
      a: agent({ name: "w-shared-a", todo_id: shared }),
      b: agent({ name: "w-shared-b", todo_id: shared }),
      plain: agent({ name: "w-plain" }),
      archived: agent({ name: "w-archived", todo_id: gone }),
      foreign: agent({ name: "w-foreign", todo_id: foreign }),
      done: agent({ name: "w-done", todo_id: done }),
      closed: agent({ name: "w-closed", todo_id: lonely, status: "closed" }),
      command: agent({ name: "w-command", kind: "command" }),
    };
    db.prepare("INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, todo_id) VALUES (?, 'agent:77', 'w-other-project', '%1', 'claude', '/x', 'agent', 'running', ?)").run(other.id, mine);

    const lanes = collectCrew(project, NOW).lanes;
    const rows = lanes.map((l) => [l.worker?.name ?? null, l.todo?.slug ?? null]);
    assert.deepEqual(rows, [
      ["w-mine", "mine"],
      ["w-shared-a", "shared"],
      ["w-shared-b", "shared"],
      ["w-plain", null],
      ["w-archived", null],
      ["w-foreign", null],
      ["w-done", "done"],
      [null, "lonely"],
    ]);
    assert.equal(lanes.some((l) => l.worker?.id === w.closed || l.worker?.id === w.command), false);
    assert.equal(lanes.at(-1).todo.status, "in_progress");
    assert.equal(lanes[0].worker.age_seconds, 3600);
    assert.equal(lanes[0].worker.created_at, "2026-10-08T11:00:00.000Z");
    assert.equal(lanes[0].worker.state_changed_at, "2026-10-08T11:50:00.000Z");
    assert.equal(lanes[0].worker.model, "opus");
    assert.equal(lanes[0].worker.harness, "claude");
    db.prepare("DELETE FROM agents").run();
    db.prepare("DELETE FROM todos").run();
  });

  it("needs-you keeps tagged noncompleted nonarchived todos in id order", () => {
    const first = todo({ tags: '["needs-human"]', slug: "first" });
    todo({ tags: '["needs-human"]', status: "completed" });
    todo({ tags: '["needs-human"]', archived_at: "2026-10-01 00:00:00" });
    todo({ tags: '["other"]' });
    const second = todo({ tags: '["x","needs-human"]', slug: "second", status: "in_progress" });
    assert.deepEqual(collectCrew(project, NOW).needs_you, [
      { id: first, slug: "first" },
      { id: second, slug: "second" },
    ]);
    db.prepare("DELETE FROM todos").run();
  });
});

describe("collectCrew wakes", () => {
  it("standing watches do not inflate pending and next carries label", () => {
    const later = wake({ body: "\n  later one  \nsecond", due_at: "2026-10-09 09:00:00" });
    const sooner = wake({ body: `${"x".repeat(80)}`, due_at: "2026-10-08 13:00:00.250" });
    wake({ body: "idle wait", kind: "idle_any", max_wait_at: "2026-10-08 18:00:00" });
    wake({ body: "cancelled", due_at: "2026-10-08 12:30:00", cancelled_at: "2026-10-08 11:00:00" });
    wake({ body: "fired", due_at: "2026-10-08 12:30:00", fired_at: "2026-10-08 11:00:00" });
    const repeating = wake({ body: "repeat", due_at: "2026-10-08 12:45:00", fired_at: "2026-10-08 11:00:00" });
    db.prepare("UPDATE wakes SET repeat_every_ms = 60000 WHERE id = ?").run(repeating);
    const watch = wake({ body: "\n\nproject watch\nmore", kind: "idle_any", watch_scope: "project", max_wait_at: "2026-10-08 12:01:00" });

    const wakes = collectCrew(project, NOW).wakes;
    assert.equal(wakes.pending, 4, "later, sooner, idle wait and the repeating wake; never the watch");
    assert.equal(wakes.next.id, repeating, "earliest by COALESCE(due_at, max_wait_at), ties by id");
    assert.deepEqual(wakes.watching.map((w) => [w.id, w.label, w.scope]), [[watch, "project watch", "project"]]);

    db.prepare("UPDATE wakes SET cancelled_at = datetime('now') WHERE id = ?").run(repeating);
    const next = collectCrew(project, NOW).wakes.next;
    assert.deepEqual(next, { id: sooner, label: "x".repeat(60), due_at: "2026-10-08T13:00:00.250Z", generated: false, held: null });
    assert.equal(collectCrew(project, NOW).wakes.pending, 3);
    assert.equal(later > 0, true);
    db.prepare("DELETE FROM wakes").run();
    assert.deepEqual(collectCrew(project, NOW).wakes, { pending: 0, next: null, watching: [], watched_worker_ids: [] });
  });

  it("an undated idle wake is last and its next due_at comes from max_wait_at", () => {
    const idle = wake({ body: "idle", kind: "idle_any", max_wait_at: "2026-10-08 18:00:00" });
    assert.deepEqual(collectCrew(project, NOW).wakes.next, { id: idle, label: "idle", due_at: "2026-10-08T18:00:00.000Z", generated: false, held: null });
    const dated = wake({ body: "dated", due_at: "2026-10-09 18:00:00" });
    assert.equal(collectCrew(project, NOW).wakes.next.id, idle);
    assert.equal(dated > idle, true);
    db.prepare("DELETE FROM wakes").run();
  });

  it("watched_worker_ids lists workers named by pending one-shot idle wakes, never a notice or a standing watch", () => {
    const one = wake({ body: "one-shot", kind: "idle_any", max_wait_at: "2026-10-08 18:00:00" });
    db.prepare("UPDATE wakes SET watch = '[7,9,7]' WHERE id = ?").run(one);
    const standingId = wake({ body: "standing", kind: "idle_any", watch_scope: "project" });
    db.prepare("UPDATE wakes SET watch = '[3]' WHERE id = ?").run(standingId);
    const notice = wake({ body: "notice", kind: "idle_any" });
    db.prepare("UPDATE wakes SET watch = '[4]', parent_wake_id = ? WHERE id = ?").run(standingId, notice);
    assert.deepEqual(collectCrew(project, NOW).wakes.watched_worker_ids, [7, 9]);
    db.prepare("DELETE FROM wakes").run();
  });

  it("next carries generated for a watch notice and a short held label from the hold reason", async () => {
    const { HELD_REASON_CONVERSATION } = await import("../dist/scheduler.js");
    const parent = wake({ body: "watch", kind: "idle_any", watch_scope: "project", max_wait_at: "2026-10-08 18:00:00" });
    const notice = wake({ body: "crew notice body\nmore", due_at: "2026-10-08 12:00:00" });
    db.prepare("UPDATE wakes SET parent_wake_id = ?, held_at = datetime('now'), held_reason = ? WHERE id = ?").run(parent, HELD_REASON_CONVERSATION, notice);
    const next = collectCrew(project, NOW).wakes.next;
    assert.equal(next.generated, true);
    assert.equal(next.held, "talking");
    db.prepare("UPDATE wakes SET held_at = NULL, held_reason = NULL WHERE id = ?").run(notice);
    assert.equal(collectCrew(project, NOW).wakes.next.held, null);
    assert.equal(collectCrew(project, NOW).wakes.watching[0].max_wait_at, "2026-10-08T18:00:00.000Z");
    db.prepare("DELETE FROM wakes").run();
  });
});

describe("held label", () => {
  it("heldReasonLabel returns typing, talking, needs you and blocked for their reasons", async () => {
    const m = await import("../dist/scheduler.js");
    const { heldReasonLabel } = await import("../dist/heldLabel.js");
    assert.equal(heldReasonLabel(m.HELD_REASON_UNSUBMITTED_INPUT), "typing");
    assert.equal(heldReasonLabel(m.HELD_REASON_CONVERSATION), "talking");
    assert.equal(heldReasonLabel(m.HELD_REASON_LEAD_PANE_DEAD), "needs you");
    assert.equal(heldReasonLabel(m.HELD_REASON_UNCLASSIFIABLE_PANE), "needs you");
    assert.equal(heldReasonLabel(m.HELD_REASON_COPY_MODE), "blocked");
    assert.equal(heldReasonLabel(null), "blocked");
  });
});

describe("activity labels", () => {
  const vars = {
    test_all: "npm test",
    test_one: "npm run build && node --test test/<file>.test.mjs",
    check: "npm run lint && npx tsc --noEmit",
    install: "npm install",
  };

  it("configured wildcard full suite and generic node PHP Taskfile labels", () => {
    assert.equal(labelOf("npm test", vars), "testing full suite");
    assert.equal(labelOf("npm test -- --watch=false", vars), "testing full suite");
    assert.equal(labelOf("cd /w && npm run build && node --test test/crew.test.mjs", vars), "testing");
    assert.equal(labelOf("node --test test/.test.mjs", { ...vars, test_one: "./one.sh test/<file>.js" }), "testing", "generic node --test still applies");
    assert.equal(labelOf("./one.sh test/.js", { test_one: "./one.sh test/<file>.js" }), "running one.sh", "an empty <file> is not a match");
    assert.equal(labelOf("./one.sh test/a.js --fast", { test_one: "./one.sh test/<file>.js" }), "testing");
    assert.equal(labelOf("npm run lint", vars), "building");
    assert.equal(labelOf("npx tsc --noEmit --pretty", vars), "building");
    assert.equal(labelOf("npm install", vars), "installing");
    assert.equal(labelOf("run.sh [fast]+", { check: "run.sh [fast]+" }), "building");
    assert.equal(labelOf("run.sh fast", { check: "run.sh [fast]+" }), "running run.sh", "metacharacters in a var are literal");
    assert.equal(labelOf("npm test", { test_all: "", check: "   " }), "testing", "empty vars create no matcher");

    assert.equal(labelOf("task test"), "testing", "task test is not a full-suite signal");
    assert.equal(labelOf("task test", { test_all: "task test" }), "testing full suite");
    assert.equal(labelOf("task test:unit"), "testing");
    assert.equal(labelOf("task check"), "building");
    assert.equal(labelOf("task build"), "building");
    assert.equal(labelOf("php artisan test --filter=Foo"), "testing");
    assert.equal(labelOf("./vendor/bin/pest tests/Feature"), "testing");
    assert.equal(labelOf("vendor/bin/phpunit"), "testing");
    assert.equal(labelOf("php vendor/bin/pest"), "testing");
    assert.equal(labelOf("pest --parallel"), "testing");
    assert.equal(labelOf("npx vitest run"), "testing");
    assert.equal(labelOf("pnpm exec jest"), "testing");
    assert.equal(labelOf("yarn test"), "testing");
    assert.equal(labelOf("pnpm run test"), "testing");
    assert.equal(labelOf("node --test test/a.test.mjs"), "testing");
    assert.equal(labelOf("./vendor/bin/pint --test"), "building");
    assert.equal(labelOf("vendor/bin/phpstan analyse"), "building");
    assert.equal(labelOf("composer check"), "building");
    assert.equal(labelOf("yarn run build"), "building");
    assert.equal(labelOf("npm run check"), "building");
    assert.equal(labelOf("composer install"), "installing");
    assert.equal(labelOf("composer update"), "installing");
    assert.equal(labelOf("pnpm install"), "installing");
    assert.equal(labelOf("npm ci"), "installing");
    assert.equal(labelOf("composer dump-autoload"), "running composer");
  });

  it("test_one beats an overlapping test_all and bare test_all stays the full suite", () => {
    const overlap = { test_all: "npm test", test_one: "npm test -- <file>" };
    assert.equal(labelOf("npm test -- test/a.test.mjs", overlap), "testing");
    assert.equal(labelOf("npm test", overlap), "testing full suite");
    assert.equal(labelOf("npm test --silent", overlap), "testing full suite");
    const taskOverlap = { test_all: "task test", test_one: "task test -- <file>" };
    assert.equal(labelOf("task test -- spec/a.rb", taskOverlap), "testing");
    assert.equal(labelOf("task test", taskOverlap), "testing full suite");
  });

  it("file is a wildcard only in test_one and literal in every other var", () => {
    assert.equal(labelOf("node --test a.mjs", { test_all: "node --test <file>" }), "testing", "generic node --test, not a full-suite match");
    assert.equal(labelOf("./all.sh <file>", { test_all: "./all.sh <file>" }), "testing full suite", "the literal text still matches itself");
    assert.equal(labelOf("./all.sh a.mjs", { test_all: "./all.sh <file>" }), "running all.sh");
    assert.equal(labelOf("./chk.sh a.mjs", { check: "./chk.sh <file>" }), "running chk.sh");
    assert.equal(labelOf("./one.sh a.mjs", { test_one: "./one.sh <file>" }), "testing");
  });

  it("quoted prose and unmatched commands never guess test or commit", () => {
    assert.equal(labelOf('echo "npm test"', { test_all: "npm test" }), "running echo");
    assert.equal(labelOf("printf 'git commit -m x'"), "running printf");
    assert.equal(labelOf("echo 'a && git commit'"), "running echo");
    assert.equal(labelOf("git commit -m 'wip'"), "committing");
    assert.equal(labelOf('git commit -m "a; b"'), "committing");
    assert.equal(labelOf("git push origin main"), "running git");
    assert.equal(labelOf("git status"), "reading");
    assert.equal(labelOf("echo hi && git diff HEAD"), "reading", "the last recognized segment wins");
    assert.equal(labelOf("npm test && echo done"), "testing", "an unrecognized tail does not erase the test");
    assert.equal(labelOf("FOO=1 BAR=2 npm test"), "testing");
    assert.equal(labelOf("cd /tmp && ls -la"), "running ls");
    assert.equal(labelOf("make all"), "running make");
    assert.equal(labelOf("sed -i s/a/b/ file"), "running sed");
    assert.equal(labelOf("rg foo src | head"), "reading");
    assert.equal(labelOf("npm run"), "running npm");
    assert.equal(labelOf("cat > t.sh <<'EOF'\nnpm test\nEOF", { test_all: "npm test" }), "editing", "a heredoc body is prose");
    assert.equal(labelOf("cat <<EOF\ngit commit -m x\nEOF"), "reading", "a bare delimiter is skipped too");
    assert.equal(labelOf("cat > t.sh <<-'EOF'\n\tnpm test\n\tEOF\nls"), "editing");
    assert.equal(labelOf("cat > f <<'EOF'\nnpm test\nEOF\ngit commit -am x"), "committing", "commands after the terminator still count");
    assert.equal(labelOf("cat <<A <<B\nnpm test\nA\nnpm run build\nB\nls -la"), "reading", "two heredocs on one line");
    assert.equal(labelOf('git commit -m "$(cat <<\'EOF\'\nnpm test passes\nEOF\n)"'), "committing");
    assert.equal(labelOf("cat <<EOF"), "reading", "an unterminated heredoc swallows nothing it cannot see");
    assert.equal(labelOf("npm   test"), "testing");
    assert.equal(labelOf("npm 'test'"), "testing");
    assert.equal(labelOf('"npm test"'), "running npm test", "a quoted whole command is one word, not two");
    assert.equal(labelOf(""), "running shell");
    assert.equal(classifyActivity([call("Bash", {})], {}).label, "running shell");
  });

  it("a redirect makes a read an edit and a null redirect does not", () => {
    assert.equal(labelOf("cat >> notes.md"), "editing");
    assert.equal(labelOf("cat a > b"), "editing");
    assert.equal(labelOf("git diff > out.patch"), "editing");
    assert.equal(labelOf("rg foo 2>/dev/null"), "reading");
    assert.equal(labelOf("rg foo 2>&1 | head"), "reading");
    assert.equal(labelOf("cat 'a>b'"), "reading", "a quoted > is not a redirect");
    assert.equal(labelOf("npm test > out.log", { test_all: "npm test" }), "testing full suite", "only a read is turned into an edit");
  });

  it("other tools map to reading editing reviewing or running their last name component", () => {
    const one = (c) => classifyActivity([c], {}).label;
    for (const name of ["Read", "Glob", "Grep", "read_file", "view_image"]) assert.equal(one(call(name)), "reading", name);
    for (const name of ["Edit", "Write", "MultiEdit", "apply_patch"]) assert.equal(one(call(name)), "editing", name);
    assert.equal(one(call("mcp__hive__pad_read")), "reading");
    assert.equal(one(call("mcp__hive__todo_get")), "reading");
    assert.equal(one(call("mcp__hive__todo_list")), "reading");
    assert.equal(one(call("mcp__hive__todo_update")), "running todo_update");
    assert.equal(one(call("functions.exec", { source: "git commit; npm test" })), "running exec", "orchestration source is never read");
    const withSkill = (c) => classifyActivity([c], { review_skills: "code-review" }).label;
    assert.equal(withSkill(call("Skill", { skill: "code-review" })), "reviewing");
    assert.equal(withSkill(call("Skill", { skill: "other" })), "running Skill");
    assert.equal(one(call("Skill", { skill: "code-review" })), "running Skill", "no review_skills var means no skill-name matcher");
    assert.equal(classifyActivity([call("Skill", { skill: "x" })], { review_skills: "  " }).label, "running Skill");
    const two = { review_skills: " code-review ,, arch-review , " };
    assert.equal(classifyActivity([call("Skill", { skill: "code-review" })], two).label, "reviewing");
    assert.equal(classifyActivity([call("Skill", { skill: "arch-review" })], two).label, "reviewing");
    assert.equal(classifyActivity([call("Skill", { skill: "other-review" })], two).label, "running Skill", "an unlisted skill is not a review");
    assert.equal(classifyActivity([call("Skill", { skill: "" })], two).label, "running Skill", "a blank list item matches nothing");
    assert.deepEqual(reviewSkillsOf(two), ["code-review", "arch-review"]);
    assert.deepEqual(reviewSkillsOf({ review_skills: ",  ," }), []);
    assert.deepEqual(reviewSkillsOf({}), []);
    assert.equal(one(call("Agent", { subagent_type: "code-reviewer" })), "reviewing");
    assert.equal(one(call("Task", { subagent_type: "review-agent" })), "reviewing");
    assert.equal(one(call("Agent", { subagent_type: "Explore" })), "running Agent");
    assert.equal(one(call("WebFetch")), "running WebFetch");
  });
});

const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const codexWorker = (path) => ({ actor_id: "agent:1", cwd: "/work/cwd", session_id: "", transcript_path: path });
const codexCallRecord = (name, args, timestamp) => ({
  type: "response_item",
  timestamp,
  payload: { type: "function_call", name, arguments: JSON.stringify(args), call_id: "c1" },
});

describe("review marker end to end", () => {
  it("a Codex assistant review marker is read from the transcript and classified as reviewing end to end", () => {
    const file = join(dirs.tmp, "codex-review.jsonl");
    const message = (role, text) => ({ type: "response_item", timestamp: "2026-10-08T11:00:01Z", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
    writeFileSync(file, jsonl(
      codexCallRecord("exec_command", { cmd: "git status" }, "2026-10-08T11:00:00Z"),
      message("assistant", "Running the pass.\n$code-review --effort=medium"),
      codexCallRecord("exec_command", { cmd: "rg foo src" }, "2026-10-08T11:00:02Z"),
    ));
    const calls = readRecentToolCalls("codex", codexWorker(file), { reviewSkills: ["code-review"] }).calls;
    assert.deepEqual(calls.map((c) => c.name), ["Bash", "Skill", "Bash"]);
    assert.deepEqual(classifyActivity(calls, { review_skills: "code-review" }), { label: "reviewing", since: "2026-10-08T11:00:01.000Z", lower_bound: false });
    assert.equal(classifyActivity(calls, {}).label, "reading", "absent review_skillss: no skill-name matcher");
    const second = join(dirs.tmp, "codex-review-second.jsonl");
    writeFileSync(second, jsonl(message("assistant", "$arch-review")));
    const secondCalls = readRecentToolCalls("codex", codexWorker(second), { reviewSkills: ["code-review", "arch-review"] }).calls;
    assert.deepEqual(secondCalls.map((c) => c.input.skill), ["arch-review"], "the second listed name marks too");
    assert.equal(classifyActivity(secondCalls, { review_skills: "code-review, arch-review" }).label, "reviewing");
    const user = join(dirs.tmp, "codex-review-user.jsonl");
    writeFileSync(user, jsonl(message("user", "$code-review"), message("assistant", "ok $code-review inline"), message("assistant", "$code-reviewer")));
    assert.deepEqual(readRecentToolCalls("codex", codexWorker(user), { reviewSkills: ["code-review"] }).calls, [], "user text, mid-line mentions and longer names are not markers");
  });
});

describe("codex exec wrapper classification", () => {
  const execRecord = (input) => ({ type: "response_item", timestamp: "2026-10-08T11:00:00Z", payload: { type: "custom_tool_call", name: "exec", input, call_id: "c1" } });
  const labelFor = (name, ...records) => {
    const file = join(dirs.tmp, `${name}.jsonl`);
    writeFileSync(file, jsonl(...records));
    return classifyActivity(readRecentToolCalls("codex", codexWorker(file)).calls, {}).label;
  };

  it("an exec-wrapped npm test classifies testing, apply_patch editing, todo_get reading", () => {
    assert.equal(labelFor("x-test", execRecord('const r=await tools.exec_command({cmd:"npm test > run.log 2>&1",workdir:"/w"}); text(JSON.stringify(r));')), "testing");
    assert.equal(labelFor("x-patch", execRecord('await tools.apply_patch({input:"*** Begin Patch"});')), "editing");
    assert.equal(labelFor("x-mcp", execRecord("const r = await tools.mcp__hive__todo_get({todo_id:1}); text(r);")), "reading");
  });

  it("write_stdin and sleep after an exec-wrapped npm test keep testing", () => {
    assert.equal(labelFor(
      "x-wait",
      execRecord('await tools.exec_command({cmd:"npm test"});'),
      execRecord("await tools.write_stdin({session_id:1,chars:\"\"});"),
      { type: "response_item", payload: { type: "function_call", name: "sleep", arguments: "{}" } },
    ), "testing");
  });
});

describe("activity timing", () => {
  const at = (n) => `2026-10-08T10:00:${String(n).padStart(2, "0")}.000Z`;

  it("review reading timing and editing transition follow bounded evidence", () => {
    const reviewVars = { review_skills: "code-review" };
    const review = [call("Skill", { skill: "code-review" }, at(1)), call("Read", {}, at(2)), call("Grep", {}, at(3))];
    assert.deepEqual(classifyActivity(review, reviewVars), { label: "reviewing", since: at(1), lower_bound: true });
    const ended = [...review, call("Edit", {}, at(4))];
    assert.deepEqual(classifyActivity(ended, reviewVars), { label: "editing", since: at(4), lower_bound: false });
    const afterTest = [...review, bash("npm test", at(4)), call("Read", {}, at(5))];
    assert.deepEqual(classifyActivity(afterTest, reviewVars), { label: "reading", since: at(5), lower_bound: false }, "a test ends the review window");
    const readFirst = [call("Read", {}, at(1)), call("Grep", {}, at(2)), call("Read", {}, at(3))];
    assert.equal(classifyActivity(readFirst, {}).label, "reading", "reading with no review marker stays reading");
    const mcp = [...review, call("mcp__hive__todo_update", {}, at(4)), call("Read", {}, at(5))];
    assert.equal(classifyActivity(mcp, reviewVars).label, "reading", "an other-tool call ends the review window");
  });

  it("since is the oldest stamp of the trailing run and carries a lower bound only at the window edge", () => {
    const run = [call("Edit", {}, at(1)), call("Read", {}, at(2)), call("Read", {}, at(3)), call("Grep", {}, at(4))];
    assert.deepEqual(classifyActivity(run, {}), { label: "reading", since: at(2), lower_bound: false });
    const all = run.slice(1);
    assert.deepEqual(classifyActivity(all, {}), { label: "reading", since: at(2), lower_bound: true });
    const nullStamp = [call("Edit", {}, at(1)), call("Read", {}, null), call("Read", {}, at(3))];
    assert.deepEqual(classifyActivity(nullStamp, {}), { label: "reading", since: null, lower_bound: false });
    assert.deepEqual(classifyActivity([], {}), { label: "", since: null, lower_bound: false });
    const words = [bash("npm test", at(1)), bash("make a", at(2)), bash("make b", at(3)), bash("ninja c", at(4))];
    assert.deepEqual(classifyActivity(words, {}), { label: "running ninja", since: at(4), lower_bound: false }, "running <word> labels differ per word");
    assert.deepEqual(classifyActivity(words.slice(0, 3), {}), { label: "running make", since: at(2), lower_bound: false });
  });
});

describe("collectCrew worker facts", () => {
  it("activity comes from the recorded transcript and falls back to stored state", () => {
    const file = join(dirs.tmp, "claude-worker.jsonl");
    const line = (name, input, timestamp) =>
      JSON.stringify({ type: "assistant", timestamp, message: { content: [{ type: "tool_use", name, input }] } });
    writeFileSync(file, [
      line("Read", {}, "2026-10-08T11:58:00.000Z"),
      line("Bash", { command: "vendor/bin/pest tests/Unit" }, "2026-10-08T11:59:00.000Z"),
    ].join("\n") + "\n");
    agent({ name: "with-transcript", transcript_path: file });
    agent({ name: "no-transcript-working", agent_state: "working" });
    agent({ name: "no-transcript-idle", agent_state: "idle" });
    agent({ name: "foreign-transcript", command: "codex", session_id: "abc" });
    const byName = Object.fromEntries(collectCrew(project, NOW).lanes.map((l) => [l.worker.name, l.worker]));
    assert.deepEqual(byName["with-transcript"].activity, { label: "testing", since: "2026-10-08T11:59:00.000Z", lower_bound: false });
    assert.deepEqual(byName["no-transcript-working"].activity, { label: "working", since: null, lower_bound: false });
    assert.deepEqual(byName["no-transcript-idle"].activity, { label: "idle", since: null, lower_bound: false });
    assert.equal(byName["foreign-transcript"].activity.label, "working");
    assert.equal(byName["foreign-transcript"].harness, "codex");
    assert.equal(byName["foreign-transcript"].context_fill, null);
    db.prepare("DELETE FROM agents").run();
  });

  it("project vars classify the project's own commands", () => {
    writeFileSync(join(dirs.projectDir, "hive.yml"), "vars:\n  test_all: make everything\n  context_probe: x\ncontext_checkpoint_percent: 55\n");
    const file = join(dirs.tmp, "vars-worker.jsonl");
    writeFileSync(file, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "make everything -j4" } }] } }) + "\n");
    agent({ name: "vars", transcript_path: file });
    const snapshot = collectCrew(project, NOW);
    assert.equal(snapshot.lanes[0].worker.activity.label, "testing full suite");
    assert.equal(snapshot.context_checkpoint_percent, 55);
    writeFileSync(join(dirs.projectDir, "hive.yml"), "");
    assert.equal(collectCrew(project, NOW).context_checkpoint_percent, null);
    db.prepare("DELETE FROM agents").run();
  });

  it("owned live dialog only is red and first idle is not your turn", { skip: hasTmux ? false : "tmux is not installed" }, () => {
    const { livePane, dialogPane } = createLiveAndDialogPanes("crew-dialog", "tool-permission-prompt.txt");
    const socket = resolvedTmuxSocket();
    const pid = (pane) => paneField(pane, "#{pane_pid}");
    const waiting = (name, o) => agent({ name, agent_state: "waiting", command: "claude", tmux_socket: socket, ...o });
    waiting("dialog-owned", { tmux_target: dialogPane, pane_pid: pid(dialogPane) });
    waiting("no-dialog", { tmux_target: livePane, pane_pid: pid(livePane) });
    waiting("reissued", { tmux_target: dialogPane, pane_pid: "1" });
    waiting("unknown-pid", { tmux_target: dialogPane, pane_pid: "" });
    waiting("foreign-socket", { tmux_target: dialogPane, pane_pid: pid(dialogPane), tmux_socket: "/nonexistent/tmux-1/default" });
    waiting("gone-pane", { tmux_target: "%987654", pane_pid: "5" });
    const claude = harnessFor("claude");
    registerHarness({
      ...claude,
      name: "stateless",
      matches: (command) => command.trim().split(/\s+/)[0] === "stateless",
      stateSource: false,
      briefDelivery: null,
      classifiesPaneScreen: true,
      supportsRename: false,
      contextRecord: null,
    });
    waiting("no-state-source", { command: "stateless", tmux_target: dialogPane, pane_pid: pid(dialogPane) });
    agent({ name: "idle-on-dialog", agent_state: "idle", command: "claude", tmux_socket: socket, tmux_target: dialogPane, pane_pid: pid(dialogPane) });
    agent({ name: "idle-first", agent_state: "idle", resumed_at: "2026-10-08 11:00:00" });
    agent({ name: "idle-real", agent_state: "idle" });
    agent({ name: "busy", agent_state: "working" });

    const byName = Object.fromEntries(collectCrew(project, NOW).lanes.map((l) => [l.worker.name, l.worker]));
    assert.equal(byName["dialog-owned"].state, "blocked");
    assert.deepEqual(byName["dialog-owned"].activity, { label: "blocked", since: null, lower_bound: false });
    unregisterHarness("stateless");
    for (const name of ["no-dialog", "reissued", "unknown-pid", "foreign-socket", "gone-pane", "no-state-source"]) {
      assert.equal(byName[name].state, "waiting", name);
    }
    assert.equal(byName["idle-on-dialog"].state, "idle", "only a stored waiting row is ever captured");
    assert.equal(byName["dialog-owned"].your_turn, false);
    assert.equal(byName["idle-real"].your_turn, true);
    assert.equal(byName["idle-first"].your_turn, false, "a resumed worker's first idle is not a finish");
    assert.equal(byName["idle-on-dialog"].your_turn, true);
    assert.equal(byName["busy"].your_turn, false);
    assert.equal(db.prepare("SELECT agent_state FROM agents WHERE name = 'dialog-owned'").get().agent_state, "waiting", "no state write");
    db.prepare("DELETE FROM agents").run();
  });
});

describe("local worktree commit count", () => {
  it("local worktree commit count handles missing data", () => {
    const repo = mkdtempSync(join(tmpdir(), "hive-crew-git-"));
    const git = (cwd, ...args) => scratchGit(cwd, ...args);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
    git(repo, "commit", "-q", "--allow-empty", "-m", "root", "--no-gpg-sign");
    const wt = join(repo, "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "lane");
    assert.equal(readCommitsAhead(wt, repo), 0);
    git(wt, "config", "user.email", "t@example.com");
    git(wt, "config", "user.name", "T");
    git(wt, "commit", "-q", "--allow-empty", "-m", "one", "--no-gpg-sign");
    git(wt, "commit", "-q", "--allow-empty", "-m", "two", "--no-gpg-sign");
    assert.equal(readCommitsAhead(wt, repo), 2);
    assert.equal(readCommitsAhead(repo, repo), null, "the primary checkout is not a lane");
    assert.equal(readCommitsAhead(join(repo, "missing"), repo), null);
    assert.equal(readCommitsAhead(mkdtempSync(join(tmpdir(), "hive-crew-nogit-")), repo), null);
    assert.equal(readCommitsAhead("", repo), null);

    git(repo, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    git(wt, "commit", "-q", "--allow-empty", "-m", "three", "--no-gpg-sign");
    assert.equal(readCommitsAhead(wt, repo), 3, "a local origin/HEAD wins over main");

    git(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    git(repo, "branch", "-m", "main", "renamed");
    assert.equal(readCommitsAhead(wt, repo), null, "no local main or master means no answer");
    git(repo, "branch", "master", "renamed");
    assert.equal(readCommitsAhead(wt, repo), 3, "master is the fallback");
    assert.equal(existsSync(join(repo, ".git", "FETCH_HEAD")), false, "nothing was fetched");

    agent({ name: "in-worktree", cwd: wt });
    agent({ name: "in-primary", cwd: repo });
    const byName = Object.fromEntries(collectCrew(project, NOW).lanes.map((l) => [l.worker.name, l.worker]));
    assert.equal(byName["in-worktree"].commits_ahead, 3);
    assert.equal(byName["in-primary"].commits_ahead, null);
    db.prepare("DELETE FROM agents").run();
  });
});
