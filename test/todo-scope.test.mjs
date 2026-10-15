import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, it } from "node:test";

import { assertScratchStore, clearHiveEnv, isolateTmux, runCli, scratchDirs } from "./helpers.mjs";

clearHiveEnv();
const { cleanup } = isolateTmux("the todo scope tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
await assertScratchStore();
const { db, migrate } = await import("../dist/db.js");
const { addProject } = await import("../dist/context.js");
const { collectCrew } = await import("../dist/crew.js");
const { renderDashboard } = await import("../dist/dashboard.js");
const { collectPortfolio } = await import("../dist/portfolio.js");
migrate();

after(() => cleanup());

function seedTodo(projectId, { title, status = "open", tags = [], archived = false }) {
  return db
    .prepare(
      `INSERT INTO todos (project_id, title, status, tags, archived_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(projectId, title, status, JSON.stringify(tags), archived ? "2026-10-01 00:00:00" : null).id;
}

it("all open todo surfaces use open and in_progress, exclude archived and backlog, and share blocker semantics", async () => {
  const project = addProject(dirs.projectDir, "todo-scope-cross-surface");
  seedTodo(project.id, { title: "ordinary open" });
  const inProgress = seedTodo(project.id, { title: "in progress", status: "in_progress", tags: ["needs-human"] });
  const blocked = seedTodo(project.id, { title: "blocked open", tags: ["needs-human"] });
  const backlogBlocker = seedTodo(project.id, { title: "backlog blocker", status: "backlog" });
  db.prepare("INSERT INTO todo_blockers (todo_id, blocker_id) VALUES (?, ?)").run(blocked, backlogBlocker);
  seedTodo(project.id, { title: "shelved needs you", status: "backlog", tags: ["needs-human"] });
  seedTodo(project.id, { title: "completed needs you", status: "completed", tags: ["needs-human"] });
  seedTodo(project.id, { title: "archived open", archived: true });

  const portfolio = collectPortfolio("2026-10-15 12:00:00").projects.find((row) => row.id === project.id);
  assert.deepEqual(portfolio.todos, { open: 2, in_progress: 1, blocked: 1, blocked_in_progress: 0, high: 0 });
  assert.equal(portfolio.needs_human, 2);

  const crew = collectCrew(project, new Date("2026-10-15T12:00:00Z"));
  assert.deepEqual(crew.needs_you.map((row) => row.id), [inProgress, blocked]);
  assert.equal(crew.needs_you.length, 2, "backlog needs-human todos must not appear in the crew sidebar");

  const dashboard = renderDashboard(project.id);
  assert.match(dashboard, />3<span class="stat-unit">open<\/span>/);
  assert.match(dashboard, /3 open, 1 blocked/);
  for (const title of ["ordinary open", "in progress", "blocked open"]) assert.ok(dashboard.includes(title));
  for (const title of ["shelved needs you", "completed needs you", "archived open"])
    assert.ok(!dashboard.includes(title), `${title} must not appear in the dashboard's open list`);

  const opts = { cwd: dirs.projectDir, dataDir: dirs.dataDir, tmp: dirs.tmp };
  const status = await runCli(["status"], opts);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /open todos: 3/);
  const statusline = await runCli(["statusline"], opts);
  assert.equal(statusline.code, 0, statusline.stderr);
  assert.match(statusline.stdout, /3 todos \(2 ready\)/);
  const portfolioCli = await runCli(["portfolio", "--json"], opts);
  assert.equal(portfolioCli.code, 0, portfolioCli.stderr);
  const portfolioOutput = JSON.parse(portfolioCli.stdout).projects.find((row) => row.id === project.id);
  assert.equal(portfolioOutput.todos.open + portfolioOutput.todos.in_progress, 3);
  assert.equal(portfolioOutput.needs_human, 2);
  const crewCli = await runCli(["crew", "--json"], opts);
  assert.equal(crewCli.code, 0, crewCli.stderr);
  assert.deepEqual(JSON.parse(crewCli.stdout).needs_you.map((row) => row.id), [inProgress, blocked]);
});

it("a backlog-only project does not get a completion empty state", () => {
  const projectPath = join(dirs.tmp, "backlog-only-project");
  mkdirSync(projectPath, { recursive: true });
  const project = addProject(projectPath, "backlog-only-project");
  seedTodo(project.id, { title: "shelved work", status: "backlog" });

  const dashboard = renderDashboard(project.id);
  assert.match(dashboard, /No active todos\./);
  assert.match(dashboard, /Backlog todos stay off this list\./);
  assert.doesNotMatch(dashboard, /Every todo in this project is completed or archived/);
});
