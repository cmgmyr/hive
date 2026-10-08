import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { isolateTmux, runCli, scratchDirs } from "./helpers.mjs";
import { ago, buildCrewView, failedView, readCrew } from "../claude-plugin/crew/model.mjs";

const { cleanup } = isolateTmux("the crew mod model tests");
const dirs = scratchDirs();
process.env.HIVE_DATA_DIR = dirs.dataDir;
const { db, migrate } = await import("../dist/db.js");
const { addProject } = await import("../dist/context.js");
const { sessionName } = await import("../dist/tmux.js");
migrate();
after(() => cleanup(sessionName()));

const NOW = Date.parse("2026-10-08T12:00:00.000Z");

const activity = (o = {}) => ({ label: "editing", since: "2026-10-08T11:58:00.000Z", lower_bound: false, ...o });
const worker = (o = {}) => ({
  id: 7, name: "w7", model: "opus", harness: "claude", state: "working",
  created_at: "2026-10-08T10:00:00.000Z", state_changed_at: "2026-10-08T11:50:00.000Z", session_id: "s1",
  age_seconds: 7200, activity: activity(), context_fill: { used_tokens: 1, window_tokens: 2, used_percent: 41.4 },
  your_turn: false, commits_ahead: null, ...o,
});
const lane = (todo, w) => ({ todo, worker: w });
const todoOf = (id, slug) => ({ id, slug, status: "in_progress" });
const snapshot = (o = {}) => ({
  schema_version: 1, project: { id: 1, name: "proj" }, read_at: "2026-10-08T12:00:00.000Z",
  lanes: [], needs_you: [], wakes: { pending: 0, next: null, watching: [] }, context_checkpoint_percent: null, ...o,
});
const runOk = (snap) => async () => ({ exitCode: 0, stdout: JSON.stringify(snap), stderr: "" });

describe("readCrew", () => {
  it("one crew argv read validates schema and reports failures", async () => {
    const calls = [];
    const run = async (argv, init) => {
      calls.push([argv, init]);
      return { exitCode: 0, stdout: JSON.stringify(snapshot()), stderr: "" };
    };
    assert.equal((await readCrew(run, "/some/cwd")).schema_version, 1);
    assert.deepEqual(calls, [[["hive", "crew", "--json"], { cwd: "/some/cwd", timeoutMs: 4000 }]]);

    await assert.rejects(readCrew(runOk(snapshot({ schema_version: 2 })), "/c"), /schema 2 is not 1/);
    await assert.rejects(readCrew(runOk({ ...snapshot(), lanes: null }), "/c"), /missing lanes/);
    await assert.rejects(readCrew(async () => ({ exitCode: 0, stdout: "not json", stderr: "" }), "/c"), /invalid JSON/);
    await assert.rejects(
      readCrew(async () => ({ exitCode: 1, stdout: "", stderr: "\nhive crew: unknown project\nmore" }), "/c"),
      /exit 1: hive crew: unknown project/,
    );
    await assert.rejects(readCrew(async () => ({ exitCode: 2, stdout: "", stderr: "" }), "/c"), /^Error: exit 2$/);
    await assert.rejects(readCrew(async () => { throw new Error("timed out"); }, "/c"), /did not answer: timed out/);
  });

  it("real hive crew --json output builds a view", async () => {
    const project = addProject(dirs.projectDir, "mod-proj");
    const t = db.prepare("INSERT INTO todos (project_id, title, status, slug) VALUES (?, 't', 'in_progress', 'real lane') RETURNING id").get(project.id).id;
    db.prepare(
      `INSERT INTO agents (project_id, actor_id, name, tmux_target, command, cwd, kind, status, agent_state, model, todo_id)
       VALUES (?, 'agent:real', 'real-w', '%999', 'claude', ?, 'agent', 'running', 'working', 'opus', ?)`,
    ).run(project.id, dirs.projectDir, t);
    const run = async (argv, init) => {
      const r = await runCli(argv.slice(1), { cwd: init.cwd, dataDir: dirs.dataDir, tmp: dirs.tmp });
      return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
    };
    const view = buildCrewView(await readCrew(run, dirs.projectDir), null, Date.now());
    assert.equal(view.header, "mod-proj · 1 worker");
    assert.equal(view.rows[0].id, String(t));
    assert.equal(view.rows[0].slug, "real lane");
    assert.equal(view.rows[0].model, "opus");
  });
});

describe("buildCrewView", () => {
  it("two-line rows retain id model activity timing age and ctx", () => {
    const view = buildCrewView(snapshot({ lanes: [lane(todoOf(1798, "crew mod"), worker({ commits_ahead: 3 }))] }), null, NOW);
    assert.deepEqual(view.rows[0], {
      key: "w7", color: "green", id: "1798", slug: "crew mod", model: "opus", activity: "editing 2m",
      ctx: "ctx 41%", rest: "2h0m · +3 commits", ctxAmber: false,
    });
    assert.equal(ago(59), "59s");
    assert.equal(ago(-5), "0s");
  });

  it("unstaffed duplicate todo and unlinked workers stay distinct", () => {
    const view = buildCrewView(
      snapshot({
        lanes: [
          lane(todoOf(5, "shared"), worker({ id: 1, name: "a", session_id: "x" })),
          lane(todoOf(5, "shared"), worker({ id: 2, name: "b", session_id: "y" })),
          lane(null, worker({ id: 3, name: "loose", session_id: "z", model: null, harness: "codex" })),
          lane(todoOf(9, "nobody"), null),
        ],
      }),
      null,
      NOW,
    );
    assert.deepEqual(view.rows.map((r) => r.key), ["w1", "w2", "w3", "t9"]);
    assert.equal(view.rows[2].id, "--");
    assert.equal(view.rows[2].slug, "loose unlinked");
    assert.equal(view.rows[2].model, "codex");
    assert.equal(view.rows[3].activity, "unstaffed");
    assert.equal(view.rows[3].color, "gray");
    assert.equal(view.header, "proj · 3 workers");
  });

  it("threshold your-turn watch and metric tokens follow JSON evidence", () => {
    const view = buildCrewView(
      snapshot({
        context_checkpoint_percent: 40,
        lanes: [
          lane(todoOf(1, "hot"), worker({ id: 1 })),
          lane(todoOf(2, "turn"), worker({ id: 2, state: "idle", your_turn: true, activity: activity({ label: "idle", since: null }), context_fill: null })),
          lane(todoOf(3, "dialog"), worker({ id: 3, state: "blocked", activity: activity({ label: "blocked", since: null }) })),
          lane(todoOf(4, "cool"), worker({ id: 4, context_fill: { used_tokens: 1, window_tokens: 9, used_percent: 39.9 }, state: "stopped" })),
        ],
        needs_you: [{ id: 12, slug: "decide" }],
        wakes: {
          pending: 2,
          next: { id: 3, label: "check lanes", due_at: "2026-10-08T12:05:00.000Z" },
          watching: [{ id: 4, label: "idle watch" }],
        },
      }),
      null,
      NOW,
    );
    const [hot, turn, dialog, cool] = view.rows;
    assert.equal(hot.ctxAmber, true);
    assert.equal(cool.ctxAmber, false);
    assert.equal(turn.color, "yellow");
    assert.equal(turn.ctx, "ctx ?");
    assert.equal(turn.ctxAmber, false);
    assert.match(turn.activity, /^your turn /);
    assert.equal(dialog.color, "red");
    assert.match(dialog.activity, /^blocked ~0s$/);
    assert.equal(cool.color, "gray");
    assert.deepEqual(view.needsYou, [{ id: "12", slug: "decide" }]);
    assert.deepEqual(view.footer, ["next in 5m: check lanes", "watching: idle watch"]);
    const none = buildCrewView(snapshot(), null, NOW);
    assert.deepEqual(none.footer, ["next: none"]);
    assert.equal(view.header, "proj · 4 workers · 1 need you · next in 5m: check lanes");
    assert.equal(none.header, "proj · 0 workers");
  });

  it("observed duration resets on session change", () => {
    const blocked = (session) =>
      snapshot({ lanes: [lane(todoOf(1, "l"), worker({ state: "blocked", session_id: session, activity: activity({ label: "blocked", since: null }) }))] });
    const first = buildCrewView(blocked("s1"), null, NOW);
    assert.equal(first.rows[0].activity, "blocked ~0s");
    const later = buildCrewView(blocked("s1"), first, NOW + 90_000);
    assert.equal(later.rows[0].activity, "blocked ~1m");
    const reset = buildCrewView(blocked("s2"), later, NOW + 120_000);
    assert.equal(reset.rows[0].activity, "blocked ~0s");
    const bound = buildCrewView(
      snapshot({ lanes: [lane(todoOf(1, "l"), worker({ activity: activity({ lower_bound: true }) }))] }),
      later,
      NOW,
    );
    assert.equal(bound.rows[0].activity, "editing >=2m");
  });
});

describe("failedView", () => {
  it("failed poll preserves last good rows", () => {
    const good = buildCrewView(snapshot({ lanes: [lane(todoOf(1, "kept"), worker())] }), null, NOW);
    const failed = failedView(good, "hive crew exited 1");
    assert.equal(failed.error, "hive crew exited 1");
    assert.deepEqual(failed.rows, good.rows);
    assert.equal(failed.header, good.header);
    assert.equal(failedView(null, "boom").rows.length, 0);
    assert.equal(buildCrewView(snapshot(), failed, NOW).error, "");
  });
});
